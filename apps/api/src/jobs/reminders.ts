import { queryRows } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { flushEmailQueue } from '../modules/notifications/mailer.js';
import { notify } from '../modules/notifications/notifications.service.js';

export interface ReminderRunResult {
  dueSoonNotified: number;
  overdueNotified: number;
  emailsFlushed: number;
}

/**
 * Deadline reminders. Both queries are deduped by (user, kind, task, day)
 * inside `notify`, so running the job hourly cannot spam an assignee — they
 * get at most one due-soon and one overdue notice per task per day.
 */
export async function runReminders(): Promise<ReminderRunResult> {
  const dueSoon = await queryRows<{ org_id: string; user_id: string; task_id: string; key: string; title: string; due_date: Date }>(
    `
    SELECT t.org_id, ta.user_id, t.id AS task_id, t.key, t.title, t.due_date
      FROM tasks t
      JOIN task_assignees ta ON ta.task_id = t.id
      JOIN users u ON u.id = ta.user_id AND u.is_active
     WHERE t.status NOT IN ('done','cancelled')
       AND t.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 1
    `,
  );

  let dueSoonNotified = 0;
  for (const row of dueSoon) {
    const created = await notify({
      orgId: row.org_id,
      userIds: [row.user_id],
      kind: 'task_due_soon',
      title: `${row.key} is due ${row.due_date.toISOString().slice(0, 10)}`,
      body: row.title,
      link: `/tasks/${row.key}`,
      entityType: 'task',
      entityId: row.task_id,
      dedupeDaily: true,
    });
    dueSoonNotified += created.length;
  }

  const overdue = await queryRows<{ org_id: string; user_id: string; task_id: string; key: string; title: string; days: string }>(
    `
    SELECT t.org_id, ta.user_id, t.id AS task_id, t.key, t.title,
           (CURRENT_DATE - t.due_date)::text AS days
      FROM tasks t
      JOIN task_assignees ta ON ta.task_id = t.id
      JOIN users u ON u.id = ta.user_id AND u.is_active
     WHERE t.status NOT IN ('done','cancelled') AND t.due_date < CURRENT_DATE
    `,
  );

  let overdueNotified = 0;
  for (const row of overdue) {
    const created = await notify({
      orgId: row.org_id,
      userIds: [row.user_id],
      kind: 'task_overdue',
      title: `${row.key} is ${row.days} day(s) overdue`,
      body: row.title,
      link: `/tasks/${row.key}`,
      entityType: 'task',
      entityId: row.task_id,
      dedupeDaily: true,
    });
    overdueNotified += created.length;
  }

  // A manager also wants to know their team is slipping, but as one digest
  // rather than per task; that lands on the dashboard, not as N notices.
  const emailsFlushed = await flushEmailQueue();

  const result = { dueSoonNotified, overdueNotified, emailsFlushed };
  logger.info(result, 'reminder job complete');
  return result;
}
