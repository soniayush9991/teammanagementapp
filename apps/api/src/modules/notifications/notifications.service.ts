import type { Notification, NotificationKind } from '@teamspace/shared';
import { query, queryOne, queryRows } from '../../db/pool.js';
import { ApiError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { AuthenticatedActor } from '../../middleware/auth.js';
import { publishToUsers } from '../../realtime/bus.js';
import { queueEmail } from './mailer.js';

interface NotificationRow {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string | null;
  read_at: Date | null;
  created_at: Date;
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    link: row.link,
    readAt: row.read_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export interface CreateNotificationInput {
  orgId: string;
  userIds: string[];
  kind: NotificationKind;
  title: string;
  body?: string | null;
  link?: string | null;
  entityType?: string;
  entityId?: string;
  actorId?: string | null;
  /** Suppresses repeats of the same reminder for the same entity on one day. */
  dedupeDaily?: boolean;
}

/**
 * Fan-out respects each recipient's channel preferences, skips the actor
 * (nobody needs a notification about their own action) and pushes over the
 * socket so the bell updates without polling.
 */
export async function notify(input: CreateNotificationInput): Promise<Notification[]> {
  const recipients = [...new Set(input.userIds)].filter((userId) => userId !== input.actorId);
  if (recipients.length === 0) return [];

  if (input.dedupeDaily && input.entityId) {
    const { rows } = await query<{ user_id: string }>(
      `
      INSERT INTO notification_dedupe (user_id, kind, entity_id, day)
      SELECT unnest($1::uuid[]), $2::notification_kind, $3, CURRENT_DATE
      ON CONFLICT DO NOTHING
      RETURNING user_id
      `,
      [recipients, input.kind, input.entityId],
    );
    // Only the users for whom a dedupe row was actually inserted get notified.
    const allowed = new Set(rows.map((row) => row.user_id));
    if (allowed.size === 0) return [];
    recipients.length = 0;
    recipients.push(...allowed);
  }

  const rows = await queryRows<NotificationRow & { user_id: string; email_wanted: boolean }>(
    `
    WITH targets AS (
      SELECT u.id AS user_id,
             COALESCE(np.in_app, TRUE)  AS in_app,
             COALESCE(np.email, FALSE)  AS email
        FROM users u
        LEFT JOIN notification_preferences np
               ON np.user_id = u.id AND np.kind = $3::notification_kind
       WHERE u.id = ANY($2::uuid[]) AND u.is_active
    )
    INSERT INTO notifications (org_id, user_id, kind, title, body, link, entity_type, entity_id, actor_id, email_queued_at)
    SELECT $1, t.user_id, $3::notification_kind, $4, $5, $6, $7, $8, $9,
           CASE WHEN t.email THEN now() ELSE NULL END
      FROM targets t
     WHERE t.in_app OR t.email
    RETURNING id, user_id, kind, title, body, link, read_at, created_at,
              (email_queued_at IS NOT NULL) AS email_wanted
    `,
    [
      input.orgId,
      recipients,
      input.kind,
      input.title,
      input.body ?? null,
      input.link ?? null,
      input.entityType ?? null,
      input.entityId ?? null,
      input.actorId ?? null,
    ],
  );

  for (const row of rows) {
    const notification = toNotification(row);
    publishToUsers([row.user_id], { type: 'notification.created', notification });
    if (row.email_wanted) {
      queueEmail(row.id, row.user_id, notification).catch((error) =>
        logger.error({ err: error, notificationId: row.id }, 'failed to queue notification email'),
      );
    }
  }

  return rows.map(toNotification);
}

export async function listNotifications(
  actor: AuthenticatedActor,
  filter: { unreadOnly: boolean; kind?: NotificationKind; limit: number; offset: number },
): Promise<{ items: Notification[]; unreadCount: number }> {
  const conditions = ['n.user_id = $1'];
  const params: unknown[] = [actor.id];
  if (filter.unreadOnly) conditions.push('n.read_at IS NULL');
  if (filter.kind) {
    params.push(filter.kind);
    conditions.push(`n.kind = $${params.length}::notification_kind`);
  }
  params.push(filter.limit, filter.offset);

  const rows = await queryRows<NotificationRow>(
    `
    SELECT n.id, n.kind, n.title, n.body, n.link, n.read_at, n.created_at
      FROM notifications n
     WHERE ${conditions.join(' AND ')}
     ORDER BY n.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );

  const unread = await queryOne<{ count: string }>(
    'SELECT count(*)::text AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [actor.id],
  );

  return { items: rows.map(toNotification), unreadCount: Number(unread?.count ?? 0) };
}

export async function markRead(actor: AuthenticatedActor, notificationIds: string[]): Promise<number> {
  const { rowCount } = await query(
    'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL',
    [actor.id, notificationIds],
  );
  return rowCount ?? 0;
}

export async function markAllRead(actor: AuthenticatedActor): Promise<number> {
  const { rowCount } = await query(
    'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
    [actor.id],
  );
  return rowCount ?? 0;
}

export async function getPreferences(
  actor: AuthenticatedActor,
): Promise<{ kind: NotificationKind; inApp: boolean; email: boolean }[]> {
  const rows = await queryRows<{ kind: NotificationKind; in_app: boolean; email: boolean }>(
    'SELECT kind, in_app, email FROM notification_preferences WHERE user_id = $1 ORDER BY kind',
    [actor.id],
  );
  return rows.map((row) => ({ kind: row.kind, inApp: row.in_app, email: row.email }));
}

export async function setPreference(
  actor: AuthenticatedActor,
  kind: NotificationKind,
  inApp: boolean,
  email: boolean,
): Promise<void> {
  if (!inApp && !email) {
    // Silencing a channel entirely is allowed, but mentions must stay
    // reachable somewhere or @-ing a person becomes a black hole.
    if (kind === 'mention') throw ApiError.unprocessable('Mentions must stay enabled on at least one channel');
  }
  await query(
    `
    INSERT INTO notification_preferences (user_id, kind, in_app, email)
    VALUES ($1, $2::notification_kind, $3, $4)
    ON CONFLICT (user_id, kind) DO UPDATE SET in_app = EXCLUDED.in_app, email = EXCLUDED.email
    `,
    [actor.id, kind, inApp, email],
  );
}

export async function unreadCount(userId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    'SELECT count(*)::text AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return Number(row?.count ?? 0);
}

export async function pendingMentions(userId: string, limit = 10): Promise<Notification[]> {
  const rows = await queryRows<NotificationRow>(
    `
    SELECT id, kind, title, body, link, read_at, created_at
      FROM notifications
     WHERE user_id = $1 AND kind = 'mention' AND read_at IS NULL
     ORDER BY created_at DESC
     LIMIT $2
    `,
    [userId, limit],
  );
  return rows.map(toNotification);
}
