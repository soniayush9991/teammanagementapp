import type { Conversation, ConversationKind, ConversationVisibility } from '@teamspace/shared';
import { query, queryOne, queryRows, withTransaction } from '../../db/pool.js';
import { recordAudit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import type { AuthenticatedActor } from '../../middleware/auth.js';
import {
  assertCanReadConversation,
  assertConversationAdmin,
  assertConversationMember,
  assertSameOrg,
  assertTeamMember,
} from '../../middleware/scope.js';
import { publishToConversation, publishToUsers } from '../../realtime/bus.js';
import { notify } from '../notifications/notifications.service.js';

interface ConversationRow {
  id: string;
  kind: ConversationKind;
  visibility: ConversationVisibility;
  name: string | null;
  topic: string | null;
  team_id: string | null;
  created_by: string | null;
  last_message_at: Date | null;
  member_count: string;
  unread_count: string | null;
  counterpart_id: string | null;
  counterpart_name: string | null;
  counterpart_avatar: string | null;
}

/**
 * Conversation projection including the caller's unread count. The unread
 * count is derived from the member's last_read_at watermark, so there is no
 * per-message-per-user row to maintain.
 */
const CONVERSATION_SELECT = `
  c.id, c.kind, c.visibility, c.name, c.topic, c.team_id, c.created_by, c.last_message_at,
  (SELECT count(*) FROM conversation_members m WHERE m.conversation_id = c.id) AS member_count,
  (SELECT count(*)
     FROM messages msg
    WHERE msg.conversation_id = c.id
      AND msg.deleted_at IS NULL
      AND msg.author_id <> $1
      AND (cm.last_read_at IS NULL OR msg.created_at > cm.last_read_at)) AS unread_count,
  dm_other.id AS counterpart_id,
  dm_other.display_name AS counterpart_name,
  dm_other.avatar_url AS counterpart_avatar
`;

const CONVERSATION_FROM = `
  FROM conversations c
  LEFT JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
  LEFT JOIN LATERAL (
    SELECT u.id, u.display_name, u.avatar_url
      FROM conversation_members other
      JOIN users u ON u.id = other.user_id
     WHERE c.kind = 'dm' AND other.conversation_id = c.id AND other.user_id <> $1
     LIMIT 1
  ) dm_other ON TRUE
`;

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    kind: row.kind,
    visibility: row.visibility,
    name: row.name,
    topic: row.topic,
    teamId: row.team_id,
    memberCount: Number(row.member_count),
    createdBy: row.created_by ?? '',
    lastMessageAt: row.last_message_at?.toISOString() ?? null,
    unreadCount: Number(row.unread_count ?? 0),
    counterpart:
      row.kind === 'dm' && row.counterpart_id
        ? {
            id: row.counterpart_id,
            displayName: row.counterpart_name ?? 'Unknown',
            avatarUrl: row.counterpart_avatar,
            email: '',
            role: 'member',
            jobTitle: null,
            timezone: 'UTC',
            skills: [],
            weeklyCapacityHours: 0,
            managerId: null,
            isActive: true,
          }
        : null,
  };
}

export async function listConversations(
  actor: AuthenticatedActor,
  filter: { kind?: ConversationKind; includePublic: boolean; search?: string; limit: number },
): Promise<Conversation[]> {
  const params: unknown[] = [actor.id, actor.orgId];
  const conditions = ['c.org_id = $2', 'c.archived_at IS NULL'];

  conditions.push(
    filter.includePublic
      ? `(cm.user_id IS NOT NULL OR (c.visibility = 'public' AND c.kind = 'channel'))`
      : 'cm.user_id IS NOT NULL',
  );
  if (filter.kind) {
    params.push(filter.kind);
    conditions.push(`c.kind = $${params.length}::conversation_kind`);
  }
  if (filter.search) {
    params.push(`%${filter.search}%`);
    conditions.push(`(c.name ILIKE $${params.length} OR dm_other.display_name ILIKE $${params.length})`);
  }
  params.push(filter.limit);

  const rows = await queryRows<ConversationRow>(
    `
    SELECT ${CONVERSATION_SELECT}
    ${CONVERSATION_FROM}
     WHERE ${conditions.join(' AND ')}
     ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
     LIMIT $${params.length}
    `,
    params,
  );
  return rows.map(toConversation);
}

export async function getConversation(
  actor: AuthenticatedActor,
  conversationId: string,
): Promise<Conversation> {
  await assertCanReadConversation(actor, conversationId);
  const row = await queryOne<ConversationRow>(
    `SELECT ${CONVERSATION_SELECT} ${CONVERSATION_FROM} WHERE c.id = $3 AND c.org_id = $2`,
    [actor.id, actor.orgId, conversationId],
  );
  if (!row) throw ApiError.notFound('Conversation');
  return toConversation(row);
}

export interface CreateGroupInput {
  kind: 'group' | 'channel';
  name: string;
  topic?: string;
  visibility: ConversationVisibility;
  teamId?: string | null;
  memberIds?: string[];
}

export async function createGroup(actor: AuthenticatedActor, input: CreateGroupInput): Promise<Conversation> {
  // Orgs can switch off member-created groups; channels are always manager+.
  const org = await queryOne<{ allow_member_group_creation: boolean }>(
    'SELECT allow_member_group_creation FROM organizations WHERE id = $1',
    [actor.orgId],
  );
  if (actor.role === 'member') {
    if (input.kind === 'channel') throw ApiError.forbidden('Only a manager or admin can create a team channel');
    if (!org?.allow_member_group_creation) {
      throw ApiError.forbidden('Your organization only allows managers to create groups');
    }
  }
  if (input.teamId) await assertTeamMember(actor, input.teamId);

  const conversationId = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `
      INSERT INTO conversations (org_id, kind, visibility, name, topic, team_id, created_by)
      VALUES ($1, $2::conversation_kind, $3::conversation_vis, $4, $5, $6, $7)
      RETURNING id
      `,
      [actor.orgId, input.kind, input.visibility, input.name, input.topic ?? null, input.teamId ?? null, actor.id],
    );
    const created = rows[0];
    if (!created) throw ApiError.internal('Could not create the conversation');

    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [created.id, actor.id],
    );

    const invitees = [...new Set(input.memberIds ?? [])].filter((id) => id !== actor.id);
    if (invitees.length > 0) {
      await client.query(
        `
        INSERT INTO conversation_members (conversation_id, user_id, role, invited_by)
        SELECT $1, u.id, 'member', $2 FROM users u WHERE u.org_id = $3 AND u.id = ANY($4::uuid[]) AND u.is_active
        ON CONFLICT DO NOTHING
        `,
        [created.id, actor.id, actor.orgId, invitees],
      );
    }

    await recordAudit(
      {
        orgId: actor.orgId,
        actorId: actor.id,
        action: 'conversation.created',
        entityType: 'conversation',
        entityId: created.id,
        metadata: { kind: input.kind, visibility: input.visibility, name: input.name },
      },
      client,
    );
    return created.id;
  });

  const invitees = [...new Set(input.memberIds ?? [])].filter((id) => id !== actor.id);
  if (invitees.length > 0) {
    await notify({
      orgId: actor.orgId,
      userIds: invitees,
      kind: 'group_invitation',
      title: `${actor.displayName} added you to ${input.name}`,
      link: `/chat/${conversationId}`,
      entityType: 'conversation',
      entityId: conversationId,
      actorId: actor.id,
    });
  }

  return getConversation(actor, conversationId);
}

/**
 * Opens (or finds) the DM between two people. The sorted pair key plus a
 * unique index means two people clicking each other simultaneously still end
 * up in one conversation.
 */
export async function openDirectMessage(
  actor: AuthenticatedActor,
  otherUserId: string,
): Promise<Conversation> {
  if (otherUserId === actor.id) throw ApiError.unprocessable('You cannot open a DM with yourself');
  await assertSameOrg(actor, otherUserId);

  const [userA, userB] = [actor.id, otherUserId].sort();
  const existing = await queryOne<{ conversation_id: string }>(
    'SELECT conversation_id FROM dm_pairs WHERE org_id = $1 AND user_a = $2 AND user_b = $3',
    [actor.orgId, userA, userB],
  );
  if (existing) return getConversation(actor, existing.conversation_id);

  const conversationId = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO conversations (org_id, kind, visibility, created_by) VALUES ($1, 'dm', 'private', $2) RETURNING id`,
      [actor.orgId, actor.id],
    );
    const created = rows[0];
    if (!created) throw ApiError.internal('Could not open the conversation');

    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role) SELECT $1, unnest($2::uuid[]), 'member'`,
      [created.id, [actor.id, otherUserId]],
    );
    await client.query(
      `INSERT INTO dm_pairs (conversation_id, org_id, user_a, user_b) VALUES ($1, $2, $3, $4)`,
      [created.id, actor.orgId, userA, userB],
    );
    return created.id;
  });

  return getConversation(actor, conversationId);
}

export interface ConversationMember {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  notify: string;
  lastReadAt: string | null;
  joinedAt: string;
}

export async function listMembers(
  actor: AuthenticatedActor,
  conversationId: string,
): Promise<ConversationMember[]> {
  await assertCanReadConversation(actor, conversationId);
  const rows = await queryRows<{
    user_id: string;
    display_name: string;
    avatar_url: string | null;
    role: string;
    notify: string;
    last_read_at: Date | null;
    joined_at: Date;
  }>(
    `
    SELECT cm.user_id, u.display_name, u.avatar_url, cm.role, cm.notify, cm.last_read_at, cm.joined_at
      FROM conversation_members cm
      JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = $1
     ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name
    `,
    [conversationId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    notify: row.notify,
    lastReadAt: row.last_read_at?.toISOString() ?? null,
    joinedAt: row.joined_at.toISOString(),
  }));
}

export async function inviteMembers(
  actor: AuthenticatedActor,
  conversationId: string,
  userIds: string[],
): Promise<ConversationMember[]> {
  const scope = await assertConversationMember(actor, conversationId);
  if (scope.kind === 'dm') throw ApiError.unprocessable('A DM cannot take more participants; create a group');
  // Private groups are invite-only by their admins; public channels let any
  // member bring someone in.
  if (scope.visibility === 'private') await assertConversationAdmin(actor, conversationId);

  const conversation = await queryOne<{ name: string | null }>('SELECT name FROM conversations WHERE id = $1', [
    conversationId,
  ]);

  await query(
    `
    INSERT INTO conversation_members (conversation_id, user_id, role, invited_by)
    SELECT $1, u.id, 'member', $2 FROM users u WHERE u.org_id = $3 AND u.id = ANY($4::uuid[]) AND u.is_active
    ON CONFLICT DO NOTHING
    `,
    [conversationId, actor.id, actor.orgId, userIds],
  );

  await notify({
    orgId: actor.orgId,
    userIds,
    kind: 'group_invitation',
    title: `${actor.displayName} added you to ${conversation?.name ?? 'a conversation'}`,
    link: `/chat/${conversationId}`,
    entityType: 'conversation',
    entityId: conversationId,
    actorId: actor.id,
  });
  publishToConversation(conversationId, { type: 'conversation.updated', conversationId });

  return listMembers(actor, conversationId);
}

export async function joinConversation(actor: AuthenticatedActor, conversationId: string): Promise<Conversation> {
  const scope = await assertCanReadConversation(actor, conversationId);
  if (scope.isMember) return getConversation(actor, conversationId);
  if (scope.kind !== 'channel' || scope.visibility !== 'public') {
    throw ApiError.forbidden('This conversation is invite-only');
  }
  await query(
    `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
    [conversationId, actor.id],
  );
  publishToConversation(conversationId, { type: 'conversation.updated', conversationId });
  return getConversation(actor, conversationId);
}

export async function leaveConversation(actor: AuthenticatedActor, conversationId: string): Promise<void> {
  const scope = await assertConversationMember(actor, conversationId);
  if (scope.kind === 'dm') throw ApiError.unprocessable('A DM cannot be left; archive it instead');
  if (scope.memberRole === 'owner') {
    const others = await queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2`,
      [conversationId, actor.id],
    );
    if (Number(others?.count ?? 0) > 0) {
      throw ApiError.conflict('Hand ownership to another member before leaving');
    }
  }
  await query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [
    conversationId,
    actor.id,
  ]);
  publishToConversation(conversationId, { type: 'conversation.updated', conversationId });
}

export async function removeMember(
  actor: AuthenticatedActor,
  conversationId: string,
  userId: string,
): Promise<void> {
  await assertConversationAdmin(actor, conversationId);
  const target = await queryOne<{ role: string }>(
    'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId],
  );
  if (!target) throw ApiError.notFound('Member');
  if (target.role === 'owner') throw ApiError.forbidden('The owner cannot be removed');

  await query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [
    conversationId,
    userId,
  ]);
  publishToUsers([userId], { type: 'conversation.updated', conversationId });
}

export async function setMemberRole(
  actor: AuthenticatedActor,
  conversationId: string,
  userId: string,
  role: 'admin' | 'member' | 'owner',
): Promise<void> {
  const scope = await assertConversationAdmin(actor, conversationId);
  if (role === 'owner' && scope.memberRole !== 'owner' && actor.role !== 'admin') {
    throw ApiError.forbidden('Only the current owner can hand over ownership');
  }

  await withTransaction(async (client) => {
    if (role === 'owner') {
      // Ownership is singular: the previous owner steps down to admin.
      await client.query(
        `UPDATE conversation_members SET role = 'admin' WHERE conversation_id = $1 AND role = 'owner'`,
        [conversationId],
      );
    }
    const { rowCount } = await client.query(
      'UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId, role],
    );
    if (!rowCount) throw ApiError.notFound('Member');
  });
  publishToConversation(conversationId, { type: 'conversation.updated', conversationId });
}

export async function updateConversation(
  actor: AuthenticatedActor,
  conversationId: string,
  input: { name?: string; topic?: string | null; visibility?: ConversationVisibility },
): Promise<Conversation> {
  const scope = await assertConversationAdmin(actor, conversationId);
  if (scope.kind === 'dm') throw ApiError.unprocessable('A DM has no name or topic to change');

  const updates: string[] = [];
  const params: unknown[] = [conversationId];
  if (input.name !== undefined) {
    params.push(input.name);
    updates.push(`name = $${params.length}`);
  }
  if (input.topic !== undefined) {
    params.push(input.topic);
    updates.push(`topic = $${params.length}`);
  }
  if (input.visibility !== undefined) {
    params.push(input.visibility);
    updates.push(`visibility = $${params.length}::conversation_vis`);
  }
  if (updates.length > 0) {
    await query(`UPDATE conversations SET ${updates.join(', ')} WHERE id = $1`, params);
    publishToConversation(conversationId, { type: 'conversation.updated', conversationId });
  }
  return getConversation(actor, conversationId);
}

export async function setNotificationLevel(
  actor: AuthenticatedActor,
  conversationId: string,
  level: 'all' | 'mentions' | 'none',
): Promise<void> {
  await assertConversationMember(actor, conversationId);
  await query('UPDATE conversation_members SET notify = $3 WHERE conversation_id = $1 AND user_id = $2', [
    conversationId,
    actor.id,
    level,
  ]);
}

/** Links a task to a group so the discussion and the work stay connected. */
export async function linkTask(
  actor: AuthenticatedActor,
  conversationId: string,
  taskId: string,
): Promise<void> {
  await assertConversationMember(actor, conversationId);
  await query(
    `INSERT INTO conversation_task_links (conversation_id, task_id, linked_by) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [conversationId, taskId, actor.id],
  );
}

export async function listLinkedTasks(
  actor: AuthenticatedActor,
  conversationId: string,
): Promise<{ taskId: string; key: string; title: string; status: string }[]> {
  await assertCanReadConversation(actor, conversationId);
  return queryRows<{ taskId: string; key: string; title: string; status: string }>(
    `
    SELECT t.id AS "taskId", t.key, t.title, t.status::text AS status
      FROM conversation_task_links ctl
      JOIN tasks t ON t.id = ctl.task_id
     WHERE ctl.conversation_id = $1
     ORDER BY ctl.linked_at DESC
    `,
    [conversationId],
  );
}
