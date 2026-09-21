import {
  isoWeekKey,
  parseIsoWeekKey,
  type ManagerDashboard,
  type MemberDashboard,
  type Task,
  type TaskStatus,
} from '@teamspace/shared';
import { queryOne, queryRows } from '../../db/pool.js';
import { ApiError } from '../../lib/errors.js';
import type { AuthenticatedActor } from '../../middleware/auth.js';
import { assertTeamMember } from '../../middleware/scope.js';
import { getTeamCapacity, getUserCapacity } from '../capacity/capacity.service.js';
import { listConversations } from '../conversations/conversations.service.js';
import { pendingMentions, unreadCount } from '../notifications/notifications.service.js';
import { TASK_SELECT, toTask, type TaskRow } from '../tasks/tasks.mapper.js';

export async function managerDashboard(
  actor: AuthenticatedActor,
  teamId: string,
  weekKey = isoWeekKey(new Date()),
): Promise<ManagerDashboard> {
  await assertTeamMember(actor, teamId);
  const { start, end } = parseIsoWeekKey(weekKey);

  const [capacity, counts, upcoming, distribution, statuses] = await Promise.all([
    getTeamCapacity(actor, teamId, weekKey),
    queryOne<{ active: string; overdue: string; due_this_week: string }>(
      `
      SELECT
        count(*) FILTER (WHERE t.status NOT IN ('done','cancelled'))::text AS active,
        count(*) FILTER (WHERE t.status NOT IN ('done','cancelled') AND t.due_date < CURRENT_DATE)::text AS overdue,
        count(*) FILTER (WHERE t.status NOT IN ('done','cancelled')
                           AND t.due_date BETWEEN $2::date AND $3::date)::text AS due_this_week
        FROM tasks t
       WHERE t.team_id = $1
      `,
      [teamId, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)],
    ),
    queryRows<TaskRow>(
      `
      SELECT ${TASK_SELECT}
        FROM tasks t
       WHERE t.team_id = $1
         AND t.status NOT IN ('done','cancelled')
         AND t.due_date IS NOT NULL
       ORDER BY t.due_date, t.priority DESC
       LIMIT 10
      `,
      [teamId],
    ),
    queryRows<{ user_id: string; display_name: string; planned_hours: string; task_count: string }>(
      `
      SELECT u.id AS user_id, u.display_name,
             COALESCE(sum(CASE WHEN ta.allocated_hours > 0 THEN ta.allocated_hours ELSE t.remaining_hours END), 0)::text AS planned_hours,
             count(t.id)::text AS task_count
        FROM team_members tm
        JOIN users u ON u.id = tm.user_id AND u.is_active
        LEFT JOIN task_assignees ta ON ta.user_id = u.id
        LEFT JOIN tasks t ON t.id = ta.task_id AND t.team_id = $1 AND t.status NOT IN ('done','cancelled')
       WHERE tm.team_id = $1
       GROUP BY u.id, u.display_name
       ORDER BY u.display_name
      `,
      [teamId],
    ),
    queryRows<{ status: TaskStatus; count: string }>(
      `SELECT t.status, count(*)::text AS count FROM tasks t WHERE t.team_id = $1 GROUP BY t.status`,
      [teamId],
    ),
  ]);

  return {
    teamId,
    weekKey,
    capacity,
    activeAssignmentCount: Number(counts?.active ?? 0),
    overdueTaskCount: Number(counts?.overdue ?? 0),
    dueThisWeekCount: Number(counts?.due_this_week ?? 0),
    upcomingDeadlines: upcoming.map(toTask),
    workDistribution: distribution.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      plannedHours: Number(row.planned_hours),
      taskCount: Number(row.task_count),
    })),
    statusBreakdown: statuses.map((row) => ({ status: row.status, count: Number(row.count) })),
  };
}

export async function memberDashboard(
  actor: AuthenticatedActor,
  userId = actor.id,
  weekKey = isoWeekKey(new Date()),
): Promise<MemberDashboard> {
  if (userId !== actor.id && actor.role === 'member') {
    throw ApiError.forbidden('You can only view your own dashboard');
  }
  const { start, end } = parseIsoWeekKey(weekKey);

  const assignedTo = `
    EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $1)
  `;

  const [capacity, today, week, overdue, conversations, notifications, mentions] = await Promise.all([
    getUserCapacity(actor, userId, weekKey),
    queryRows<TaskRow>(
      `
      SELECT ${TASK_SELECT} FROM tasks t
       WHERE ${assignedTo} AND t.status NOT IN ('done','cancelled')
         AND (t.due_date = CURRENT_DATE OR t.status = 'in_progress')
       ORDER BY t.priority DESC, t.due_date NULLS LAST
       LIMIT 20
      `,
      [userId],
    ),
    queryRows<TaskRow>(
      `
      SELECT ${TASK_SELECT} FROM tasks t
       WHERE ${assignedTo} AND t.status NOT IN ('done','cancelled')
         AND t.due_date BETWEEN $2::date AND $3::date
       ORDER BY t.due_date, t.priority DESC
      `,
      [userId, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)],
    ),
    queryRows<TaskRow>(
      `
      SELECT ${TASK_SELECT} FROM tasks t
       WHERE ${assignedTo} AND t.status NOT IN ('done','cancelled') AND t.due_date < CURRENT_DATE
       ORDER BY t.due_date
       LIMIT 20
      `,
      [userId],
    ),
    // Recent conversations only make sense for the signed-in user.
    userId === actor.id
      ? listConversations(actor, { includePublic: false, limit: 6 })
      : Promise.resolve([]),
    unreadCount(userId),
    pendingMentions(userId),
  ]);

  return {
    userId,
    weekKey,
    capacity: capacity.capacity,
    todayTasks: today.map(toTask),
    weekTasks: week.map(toTask),
    overdueTasks: overdue.map(toTask),
    recentConversations: conversations,
    unreadNotificationCount: notifications,
    pendingMentions: mentions,
  };
}

/** Feeds the member dashboard's "my week" strip. */
export async function myUpcoming(actor: AuthenticatedActor, days: number): Promise<Task[]> {
  const rows = await queryRows<TaskRow>(
    `
    SELECT ${TASK_SELECT} FROM tasks t
     WHERE EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $1)
       AND t.status NOT IN ('done','cancelled')
       AND t.due_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + $2::int)
     ORDER BY t.due_date, t.priority DESC
    `,
    [actor.id, days],
  );
  return rows.map(toTask);
}
