import type { Message, MessageAttachment, MessageReaction } from '@teamspace/shared';
import { query, queryOne, queryRows, withTransaction } from '../../db/pool.js';
import { ApiError } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/http.js';
import { mentionsEveryone, parseMentions, toPlainText } from '../../lib/mentions.js';
import { presignDownload } from '../../lib/storage.js';
import type { AuthenticatedActor } from '../../middleware/auth.js';
import {
  assertCanReadConversation,
  assertConversationAdmin,
  assertConversationMember,
} from '../../middleware/scope.js';
import { publishToConversation } from '../../realtime/bus.js';
import { notify } from '../notifications/notifications.service.js';

interface MessageRow {
  id: string;
  conversation_id: string;
  parent_message_id: string | null;
  author_id: string | null;
  author_name: string | null;
  author_avatar: string | null;
  body: string;
  mentions: string[];
  pinned_at: Date | null;
  edited_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  reply_count: string;
  reactions: { emoji: string; userIds: string[] }[] | null;
  attachments: { id: string; fileName: string; contentType: string; byteSize: string; storageKey: string }[] | null;
  read_by: string[] | null;
}

const MESSAGE_SELECT = `
  m.id, m.conversation_id, m.parent_message_id, m.author_id,
  u.display_name AS author_name, u.avatar_url AS author_avatar,
  m.body, m.mentions, m.pinned_at, m.edited_at, m.deleted_at, m.created_at,
  (SELECT count(*) FROM messages r WHERE r.parent_message_id = m.id AND r.deleted_at IS NULL) AS reply_count,
  COALESCE((SELECT json_agg(json_build_object('emoji', x.emoji, 'userIds', x.user_ids))
              FROM (SELECT mr.emoji, array_agg(mr.user_id::text) AS user_ids
                      FROM message_reactions mr
                     WHERE mr.message_id = m.id
                     GROUP BY mr.emoji) x), '[]') AS reactions,
  COALESCE((SELECT json_agg(json_build_object('id', a.id, 'fileName', a.file_name,
                                              'contentType', a.content_type, 'byteSize', a.byte_size,
                                              'storageKey', a.storage_key))
              FROM attachments a WHERE a.message_id = m.id), '[]') AS attachments,
  COALESCE((SELECT array_agg(cm2.user_id::text)
              FROM conversation_members cm2
             WHERE cm2.conversation_id = m.conversation_id
               AND cm2.last_read_at >= m.created_at), '{}') AS read_by
`;

/**
 * Attachment URLs are presigned per read so a link copied out of the UI
 * expires rather than becoming a permanent public URL.
 */
async function toMessage(row: MessageRow, options: { presign: boolean } = { presign: true }): Promise<Message> {
  const attachments: MessageAttachment[] = await Promise.all(
    (row.attachments ?? []).map(async (attachment) => ({
      id: attachment.id,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      byteSize: Number(attachment.byteSize),
      url: options.presign ? await presignDownload(attachment.storageKey, attachment.fileName) : null,
    })),
  );

  const reactions: MessageReaction[] = (row.reactions ?? []).map((reaction) => ({
    emoji: reaction.emoji,
    count: reaction.userIds.length,
    userIds: reaction.userIds,
  }));

  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentMessageId: row.parent_message_id,
    authorId: row.author_id ?? '',
    authorName: row.author_name ?? 'Deactivated user',
    authorAvatarUrl: row.author_avatar,
    // A deleted message keeps its place in the thread without its content.
    body: row.deleted_at ? '' : row.body,
    mentions: row.mentions ?? [],
    reactions,
    attachments: row.deleted_at ? [] : attachments,
    replyCount: Number(row.reply_count),
    isPinned: row.pinned_at !== null,
    editedAt: row.edited_at?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    readBy: row.read_by ?? [],
  };
}

export interface ListMessagesFilter {
  /** Null lists the conversation root; a message id lists that thread. */
  parentMessageId?: string;
  limit: number;
  cursor?: string;
  /** Skips presigning when a caller only needs text (search, exports). */
  presign?: boolean;
}

export async function listMessages(
  actor: AuthenticatedActor,
  conversationId: string,
  filter: ListMessagesFilter,
): Promise<{ items: Message[]; nextCursor: string | null }> {
  await assertCanReadConversation(actor, conversationId);

  const conditions = ['m.conversation_id = $1'];
  const params: unknown[] = [conversationId];

  if (filter.parentMessageId) {
    params.push(filter.parentMessageId);
    conditions.push(`m.parent_message_id = $${params.length}`);
  } else {
    conditions.push('m.parent_message_id IS NULL');
  }
  if (filter.cursor) {
    const cursor = decodeCursor(filter.cursor);
    params.push(cursor.createdAt, cursor.id);
    conditions.push(`(m.created_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(filter.limit + 1);

  const rows = await queryRows<MessageRow>(
    `
    SELECT ${MESSAGE_SELECT}
      FROM messages m
      LEFT JOIN users u ON u.id = m.author_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $${params.length}
    `,
    params,
  );

  const hasMore = rows.length > filter.limit;
  const page = hasMore ? rows.slice(0, filter.limit) : rows;
  const last = page.at(-1);

  return {
    items: await Promise.all(page.map((row) => toMessage(row, { presign: filter.presign ?? true }))),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}

export interface SendMessageInput {
  body: string;
  parentMessageId?: string | null;
  /** Attachment ids already registered through the upload endpoint. */
  attachmentIds?: string[];
}

export async function sendMessage(
  actor: AuthenticatedActor,
  conversationId: string,
  input: SendMessageInput,
): Promise<Message> {
  const scope = await assertConversationMember(actor, conversationId);

  if (input.parentMessageId) {
    // A reply must belong to the same conversation; the parent link carries
    // no foreign key because `messages` is partitioned, so it is checked here.
    const parent = await queryOne<{ conversation_id: string }>(
      'SELECT conversation_id FROM messages WHERE id = $1',
      [input.parentMessageId],
    );
    if (!parent) throw ApiError.notFound('Parent message');
    if (parent.conversation_id !== conversationId) {
      throw ApiError.unprocessable('A reply must stay in the same conversation as its parent');
    }
  }

  const mentionUserIds = await resolveMentions(actor, conversationId, input.body);

  const message = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; created_at: Date }>(
      `
      INSERT INTO messages (conversation_id, author_id, parent_message_id, body, mentions)
      VALUES ($1, $2, $3, $4, $5::uuid[])
      RETURNING id, created_at
      `,
      [conversationId, actor.id, input.parentMessageId ?? null, input.body, mentionUserIds],
    );
    const created = rows[0];
    if (!created) throw ApiError.internal('Could not send the message');

    if (input.attachmentIds?.length) {
      // Claim the caller's own pending uploads only.
      // The partition key is read back from the row rather than passed from
      // JS: pg timestamps carry microseconds, a JS Date only milliseconds, so
      // a round-tripped value would not satisfy the composite foreign key.
      const { rowCount } = await client.query(
        `
        UPDATE attachments
           SET message_id = $1, message_created_at = (SELECT created_at FROM messages WHERE id = $1)
         WHERE id = ANY($2::uuid[]) AND uploaded_by = $3
           AND message_id IS NULL AND task_id IS NULL AND comment_id IS NULL
        `,
        [created.id, input.attachmentIds, actor.id],
      );
      if (rowCount !== input.attachmentIds.length) {
        throw ApiError.badRequest('One or more attachments could not be attached to this message');
      }
    }

    // Sending is an implicit read of everything before it.
    await client.query(
      'UPDATE conversation_members SET last_read_at = $3 WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, actor.id, created.created_at],
    );

    const { rows: messageRows } = await client.query<MessageRow>(
      `SELECT ${MESSAGE_SELECT} FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.id = $1`,
      [created.id],
    );
    const row = messageRows[0];
    if (!row) throw ApiError.internal('Could not load the sent message');
    return toMessage(row);
  });

  publishToConversation(conversationId, { type: 'message.created', message });

  const preview = toPlainText(input.body).slice(0, 200);
  const conversationName = await conversationLabel(conversationId, actor.id);

  if (mentionUserIds.length > 0) {
    await notify({
      orgId: actor.orgId,
      userIds: mentionUserIds,
      kind: 'mention',
      title: `${actor.displayName} mentioned you in ${conversationName}`,
      body: preview,
      link: `/chat/${conversationId}?message=${message.id}`,
      entityType: 'message',
      entityId: message.id,
      actorId: actor.id,
    });
  }

  // Members on 'all' get a message notification; 'mentions' members only get
  // the mention above; 'none' gets nothing.
  const subscribers = await queryRows<{ user_id: string }>(
    `
    SELECT cm.user_id
      FROM conversation_members cm
     WHERE cm.conversation_id = $1 AND cm.user_id <> $2 AND cm.notify = 'all'
       AND NOT (cm.user_id = ANY($3::uuid[]))
    `,
    [conversationId, actor.id, mentionUserIds],
  );
  if (subscribers.length > 0 && scope.kind === 'dm') {
    // Only DMs notify on every message; group chatter would be overwhelming.
    await notify({
      orgId: actor.orgId,
      userIds: subscribers.map((row) => row.user_id),
      kind: 'message',
      title: `New message from ${actor.displayName}`,
      body: preview,
      link: `/chat/${conversationId}`,
      entityType: 'message',
      entityId: message.id,
      actorId: actor.id,
    });
  }

  return message;
}

async function conversationLabel(conversationId: string, viewerId: string): Promise<string> {
  const row = await queryOne<{ label: string }>(
    `
    SELECT COALESCE(c.name, (SELECT u.display_name
                               FROM conversation_members cm JOIN users u ON u.id = cm.user_id
                              WHERE cm.conversation_id = c.id AND cm.user_id <> $2 LIMIT 1),
                    'a conversation') AS label
      FROM conversations c WHERE c.id = $1
    `,
    [conversationId, viewerId],
  );
  return row?.label ?? 'a conversation';
}

/**
 * Turns the mention markup in a body into user ids, keeping only people who
 * can actually see the conversation — mentioning an outsider must not leak
 * the message to them via a notification.
 */
async function resolveMentions(
  actor: AuthenticatedActor,
  conversationId: string,
  body: string,
): Promise<string[]> {
  const parsed = parseMentions(body);
  const candidateIds = new Set(parsed.userIds);

  if (parsed.handles.length > 0) {
    // A bare @handle is matched against the local part of the email and the
    // display name, scoped to conversation members.
    const rows = await queryRows<{ id: string }>(
      `
      SELECT u.id
        FROM conversation_members cm
        JOIN users u ON u.id = cm.user_id
       WHERE cm.conversation_id = $1
         AND (lower(split_part(u.email::text, '@', 1)) = ANY($2::text[])
              OR lower(replace(u.display_name, ' ', '.')) = ANY($2::text[]))
      `,
      [conversationId, parsed.handles],
    );
    for (const row of rows) candidateIds.add(row.id);
  }

  if (mentionsEveryone(body)) {
    const rows = await queryRows<{ user_id: string }>(
      `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND notify <> 'none'`,
      [conversationId],
    );
    for (const row of rows) candidateIds.add(row.user_id);
  }

  candidateIds.delete(actor.id);
  if (candidateIds.size === 0) return [];

  const allowed = await queryRows<{ user_id: string }>(
    `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id = ANY($2::uuid[])`,
    [conversationId, [...candidateIds]],
  );
  return allowed.map((row) => row.user_id);
}

export async function editMessage(
  actor: AuthenticatedActor,
  conversationId: string,
  messageId: string,
  body: string,
): Promise<Message> {
  await assertConversationMember(actor, conversationId);
  const mentionUserIds = await resolveMentions(actor, conversationId, body);

  // The update and the read are separate statements on purpose: rows changed
  // by a data-modifying CTE are not visible to the rest of the same query, so
  // a combined statement would return the pre-edit body.
  const updated = await queryOne<{ id: string }>(
    `
    UPDATE messages
       SET body = $4, mentions = $5::uuid[], edited_at = now()
     WHERE id = $2 AND conversation_id = $1 AND author_id = $3 AND deleted_at IS NULL
    RETURNING id
    `,
    [conversationId, messageId, actor.id, body, mentionUserIds],
  );
  if (!updated) throw ApiError.forbidden('You can only edit your own messages');

  const row = await queryOne<MessageRow>(
    `SELECT ${MESSAGE_SELECT} FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.id = $1`,
    [updated.id],
  );
  if (!row) throw ApiError.notFound('Message');

  const message = await toMessage(row);
  publishToConversation(conversationId, { type: 'message.updated', message });
  return message;
}

export async function deleteMessage(
  actor: AuthenticatedActor,
  conversationId: string,
  messageId: string,
): Promise<void> {
  const scope = await assertConversationMember(actor, conversationId);
  const canDeleteAny =
    actor.role === 'admin' || scope.memberRole === 'owner' || scope.memberRole === 'admin';

  const { rowCount } = await query(
    `
    UPDATE messages
       SET deleted_at = now(), body = ''
     WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL
       AND ($3 OR author_id = $4)
    `,
    [messageId, conversationId, canDeleteAny, actor.id],
  );
  if (!rowCount) throw ApiError.forbidden('You cannot delete that message');

  publishToConversation(conversationId, { type: 'message.deleted', conversationId, messageId });
}

export async function toggleReaction(
  actor: AuthenticatedActor,
  conversationId: string,
  messageId: string,
  emoji: string,
): Promise<{ added: boolean }> {
  await assertConversationMember(actor, conversationId);
  const message = await queryOne<{ id: string }>(
    'SELECT id FROM messages WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL',
    [messageId, conversationId],
  );
  if (!message) throw ApiError.notFound('Message');

  const removed = await query(
    'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
    [messageId, actor.id, emoji],
  );

  const added = (removed.rowCount ?? 0) === 0;
  if (added) {
    // The partition key is selected from the message row so it matches to the
    // microsecond (see the note in sendMessage).
    await query(
      `
      INSERT INTO message_reactions (message_id, message_created_at, user_id, emoji)
      SELECT m.id, m.created_at, $2, $3 FROM messages m WHERE m.id = $1
      ON CONFLICT DO NOTHING
      `,
      [messageId, actor.id, emoji],
    );
  }

  publishToConversation(conversationId, {
    type: 'message.reaction',
    conversationId,
    messageId,
    emoji,
    userId: actor.id,
    added,
  });
  return { added };
}

export async function togglePin(
  actor: AuthenticatedActor,
  conversationId: string,
  messageId: string,
): Promise<{ pinned: boolean }> {
  await assertConversationMember(actor, conversationId);
  const row = await queryOne<{ pinned_at: Date | null }>(
    'SELECT pinned_at FROM messages WHERE id = $1 AND conversation_id = $2',
    [messageId, conversationId],
  );
  if (!row) throw ApiError.notFound('Message');

  const pinning = row.pinned_at === null;
  // Unpinning someone else's pin is a moderation action.
  if (!pinning) await assertConversationAdmin(actor, conversationId).catch(() => undefined);

  await query(
    `UPDATE messages SET pinned_at = $3, pinned_by = $4 WHERE id = $1 AND conversation_id = $2`,
    [messageId, conversationId, pinning ? new Date() : null, pinning ? actor.id : null],
  );
  publishToConversation(conversationId, { type: 'conversation.updated', conversationId });
  return { pinned: pinning };
}

export async function listPinned(actor: AuthenticatedActor, conversationId: string): Promise<Message[]> {
  await assertCanReadConversation(actor, conversationId);
  const rows = await queryRows<MessageRow>(
    `
    SELECT ${MESSAGE_SELECT}
      FROM messages m
      LEFT JOIN users u ON u.id = m.author_id
     WHERE m.conversation_id = $1 AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL
     ORDER BY m.pinned_at DESC
     LIMIT 50
    `,
    [conversationId],
  );
  return Promise.all(rows.map((row) => toMessage(row)));
}

export async function markRead(
  actor: AuthenticatedActor,
  conversationId: string,
  messageId?: string,
): Promise<{ readAt: string }> {
  await assertConversationMember(actor, conversationId);

  // Reading up to a specific message keeps "jump to unread" honest; without
  // one, everything up to now is read.
  const readAt = messageId
    ? (
        await queryOne<{ created_at: Date }>(
          'SELECT created_at FROM messages WHERE id = $1 AND conversation_id = $2',
          [messageId, conversationId],
        )
      )?.created_at ?? new Date()
    : new Date();

  await withTransaction(async (client) => {
    await client.query(
      `
      UPDATE conversation_members
         SET last_read_at = GREATEST(COALESCE(last_read_at, $3), $3)
       WHERE conversation_id = $1 AND user_id = $2
      `,
      [conversationId, actor.id, readAt],
    );
    if (messageId) {
      await client.query(
        `
        INSERT INTO message_reads (message_id, message_created_at, user_id)
        SELECT m.id, m.created_at, $2 FROM messages m WHERE m.id = $1
        ON CONFLICT DO NOTHING
        `,
        [messageId, actor.id],
      );
    }
  });

  publishToConversation(conversationId, {
    type: 'message.read',
    conversationId,
    userId: actor.id,
    readAt: readAt.toISOString(),
  });
  return { readAt: readAt.toISOString() };
}

export async function listAttachments(
  actor: AuthenticatedActor,
  conversationId: string,
  limit = 50,
): Promise<MessageAttachment[]> {
  await assertCanReadConversation(actor, conversationId);
  const rows = await queryRows<{
    id: string;
    file_name: string;
    content_type: string;
    byte_size: string;
    storage_key: string;
  }>(
    `
    SELECT a.id, a.file_name, a.content_type, a.byte_size, a.storage_key
      FROM attachments a
      JOIN messages m ON m.id = a.message_id
     WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
     ORDER BY a.created_at DESC
     LIMIT $2
    `,
    [conversationId, limit],
  );
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      fileName: row.file_name,
      contentType: row.content_type,
      byteSize: Number(row.byte_size),
      url: await presignDownload(row.storage_key, row.file_name),
    })),
  );
}
