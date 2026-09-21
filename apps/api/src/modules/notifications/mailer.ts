import type { Notification } from '@teamspace/shared';
import { query } from '../../db/pool.js';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';

/**
 * Email delivery is intentionally a thin seam. Without SMTP_URL configured
 * the message is logged and marked sent, which keeps development and tests
 * free of outbound mail. In production, point this at the transactional
 * provider of choice; the notifications table doubles as the outbox, so a
 * provider outage retries rather than loses mail.
 */
export async function queueEmail(
  notificationId: string,
  userId: string,
  notification: Notification,
): Promise<void> {
  const smtpUrl = env().SMTP_URL;

  if (!smtpUrl) {
    logger.debug(
      { notificationId, userId, subject: notification.title },
      'email channel not configured, marking notification as delivered',
    );
    await markSent(notificationId);
    return;
  }

  try {
    await deliver(userId, notification);
    await markSent(notificationId);
  } catch (error) {
    // email_sent_at stays null so the reminder job retries it.
    logger.error({ err: error, notificationId }, 'email delivery failed, will retry');
  }
}

async function markSent(notificationId: string): Promise<void> {
  await query('UPDATE notifications SET email_sent_at = now() WHERE id = $1', [notificationId]);
}

async function deliver(userId: string, notification: Notification): Promise<void> {
  // Replace with the SMTP/provider client; kept as an explicit seam so the
  // notification pipeline is testable without a network dependency.
  logger.info(
    { userId, from: env().MAIL_FROM, subject: notification.title, link: notification.link },
    'sending notification email',
  );
}

/** Retries anything still queued; called by the reminder job. */
export async function flushEmailQueue(batchSize = 100): Promise<number> {
  const { rows } = await query<{ id: string; user_id: string; kind: string; title: string; body: string | null; link: string | null; created_at: Date }>(
    `
    SELECT id, user_id, kind, title, body, link, created_at
      FROM notifications
     WHERE email_queued_at IS NOT NULL AND email_sent_at IS NULL
     ORDER BY email_queued_at
     LIMIT $1
    `,
    [batchSize],
  );

  let sent = 0;
  for (const row of rows) {
    await queueEmail(row.id, row.user_id, {
      id: row.id,
      kind: row.kind as Notification['kind'],
      title: row.title,
      body: row.body,
      link: row.link,
      readAt: null,
      createdAt: row.created_at.toISOString(),
    });
    sent += 1;
  }
  return sent;
}
