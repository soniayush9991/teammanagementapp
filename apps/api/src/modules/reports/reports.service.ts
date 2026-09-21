import { isoWeekKey, rollupTeamCapacity, type MemberCapacity, type TaskStatus } from '@teamspace/shared';
import { queryRows } from '../../db/pool.js';
import { ApiError } from '../../lib/errors.js';
import type { AuthenticatedActor } from '../../middleware/auth.js';
import { assertTeamManager } from '../../middleware/scope.js';
import { loadMemberCapacity } from '../capacity/capacity.service.js';

export interface WorkloadReportRow {
  userId: string;
  displayName: string;
  jobTitle: string | null;
  weeklyCapacityHours: number;
  leaveHours: number;
  plannedHours: number;
  availableHours: number;
  overAllocationHours: number;
  utilization: number;
  band: string;
  openTaskCount: number;
  overdueTaskCount: number;
}

export interface WorkloadReport {
  teamId: string;
  weekKey: string;
  generatedAt: string;
  rows: WorkloadReportRow[];
  totals: ReturnType<typeof rollupTeamCapacity>;
}

async function teamMemberIds(teamId: string): Promise<string[]> {
  const rows = await queryRows<{ user_id: string }>(
    `SELECT tm.user_id FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = $1 AND u.is_active`,
    [teamId],
  );
  return rows.map((row) => row.user_id);
}

export async function employeeWorkloadReport(
  actor: AuthenticatedActor,
  teamId: string,
  weekKey = isoWeekKey(new Date()),
): Promise<WorkloadReport> {
  await assertTeamManager(actor, teamId);
  const snapshots = await loadMemberCapacity(actor.orgId, await teamMemberIds(teamId), weekKey);

  return {
    teamId,
    weekKey,
    generatedAt: new Date().toISOString(),
    rows: snapshots.map(toWorkloadRow),
    totals: rollupTeamCapacity(snapshots.map((snapshot) => snapshot.capacity)),
  };
}

function toWorkloadRow(member: MemberCapacity): WorkloadReportRow {
  return {
    userId: member.userId,
    displayName: member.displayName,
    jobTitle: member.jobTitle,
    weeklyCapacityHours: member.capacity.weeklyCapacityHours,
    leaveHours: member.capacity.leaveHours,
    plannedHours: member.capacity.plannedHours,
    availableHours: member.capacity.availableHours,
    overAllocationHours: member.capacity.overAllocationHours,
    utilization: member.capacity.utilization,
    band: member.capacity.band,
    openTaskCount: member.openTaskCount,
    overdueTaskCount: member.overdueTaskCount,
  };
}

export interface UtilizationTrendRow {
  weekKey: string;
  utilization: number;
  plannedHours: number;
  capacityHours: number;
  overloadedCount: number;
}

/** Utilization week by week, for the trend chart and the capacity report. */
export async function utilizationReport(
  actor: AuthenticatedActor,
  teamId: string,
  weeks: number,
): Promise<{ teamId: string; generatedAt: string; rows: UtilizationTrendRow[] }> {
  await assertTeamManager(actor, teamId);
  const memberIds = await teamMemberIds(teamId);

  const cursor = new Date();
  const rows: UtilizationTrendRow[] = [];
  for (let index = 0; index < weeks; index += 1) {
    const weekKey = isoWeekKey(cursor);
    const snapshots = await loadMemberCapacity(actor.orgId, memberIds, weekKey);
    const rollup = rollupTeamCapacity(snapshots.map((snapshot) => snapshot.capacity));
    rows.push({
      weekKey,
      utilization: rollup.utilization,
      plannedHours: rollup.totalPlannedHours,
      capacityHours: rollup.totalEffectiveCapacityHours,
      overloadedCount: rollup.overloadedCount,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }

  return { teamId, generatedAt: new Date().toISOString(), rows };
}

export interface CompletionTrendRow {
  day: string;
  completedCount: number;
  createdCount: number;
  loggedHours: number;
}

export async function completionTrendReport(
  actor: AuthenticatedActor,
  teamId: string,
  from: string,
  to: string,
): Promise<{ teamId: string; generatedAt: string; rows: CompletionTrendRow[] }> {
  await assertTeamManager(actor, teamId);

  // A full date series so a day with no activity still appears as a zero
  // rather than a gap in the chart.
  const rows = await queryRows<{ day: Date; completed: string; created: string; logged: string }>(
    `
    WITH series AS (
      SELECT generate_series($2::date, $3::date, INTERVAL '1 day')::date AS day
    )
    SELECT s.day,
           COALESCE(c.completed, 0)::text AS completed,
           COALESCE(n.created, 0)::text   AS created,
           COALESCE(c.logged, 0)::text    AS logged
      FROM series s
      LEFT JOIN (
        SELECT t.completed_at::date AS day, count(*) AS completed, sum(t.logged_hours) AS logged
          FROM tasks t
         WHERE t.team_id = $1 AND t.status = 'done' AND t.completed_at IS NOT NULL
         GROUP BY 1
      ) c ON c.day = s.day
      LEFT JOIN (
        SELECT t.created_at::date AS day, count(*) AS created
          FROM tasks t WHERE t.team_id = $1 GROUP BY 1
      ) n ON n.day = s.day
     ORDER BY s.day
    `,
    [teamId, from, to],
  );

  return {
    teamId,
    generatedAt: new Date().toISOString(),
    rows: rows.map((row) => ({
      day: row.day.toISOString().slice(0, 10),
      completedCount: Number(row.completed),
      createdCount: Number(row.created),
      loggedHours: Number(row.logged),
    })),
  };
}

export interface OverdueReportRow {
  taskKey: string;
  title: string;
  status: TaskStatus;
  priority: string;
  dueDate: string | null;
  daysOverdue: number;
  assignees: string;
  remainingHours: number;
}

export async function overdueReport(
  actor: AuthenticatedActor,
  teamId: string,
): Promise<{ teamId: string; generatedAt: string; rows: OverdueReportRow[] }> {
  await assertTeamManager(actor, teamId);
  const rows = await queryRows<{
    key: string;
    title: string;
    status: TaskStatus;
    priority: string;
    due_date: Date | null;
    days_overdue: string;
    assignees: string | null;
    remaining_hours: string;
  }>(
    `
    SELECT t.key, t.title, t.status, t.priority::text AS priority, t.due_date,
           (CURRENT_DATE - t.due_date)::text AS days_overdue,
           (SELECT string_agg(u.display_name, ', ' ORDER BY u.display_name)
              FROM task_assignees ta JOIN users u ON u.id = ta.user_id
             WHERE ta.task_id = t.id) AS assignees,
           t.remaining_hours
      FROM tasks t
     WHERE t.team_id = $1 AND t.status NOT IN ('done','cancelled') AND t.due_date < CURRENT_DATE
     ORDER BY t.due_date
    `,
    [teamId],
  );

  return {
    teamId,
    generatedAt: new Date().toISOString(),
    rows: rows.map((row) => ({
      taskKey: row.key,
      title: row.title,
      status: row.status,
      priority: row.priority,
      dueDate: row.due_date?.toISOString().slice(0, 10) ?? null,
      daysOverdue: Number(row.days_overdue),
      assignees: row.assignees ?? 'Unassigned',
      remainingHours: Number(row.remaining_hours),
    })),
  };
}

export interface ProductivityRow {
  userId: string;
  displayName: string;
  completedTasks: number;
  loggedHours: number;
  avgCycleTimeDays: number;
  overdueTasks: number;
}

/**
 * Throughput per person over a window. Cycle time is measured from creation
 * to completion; it is reported alongside volume so a high count on trivial
 * tasks is not mistaken for high output.
 */
export async function productivityReport(
  actor: AuthenticatedActor,
  teamId: string,
  from: string,
  to: string,
): Promise<{ teamId: string; generatedAt: string; rows: ProductivityRow[] }> {
  await assertTeamManager(actor, teamId);
  const rows = await queryRows<{
    user_id: string;
    display_name: string;
    completed: string;
    logged: string;
    avg_cycle: string | null;
    overdue: string;
  }>(
    `
    SELECT u.id AS user_id, u.display_name,
           count(DISTINCT t.id) FILTER (WHERE t.status = 'done')::text AS completed,
           COALESCE(sum(wl.hours), 0)::text AS logged,
           avg(EXTRACT(EPOCH FROM (t.completed_at - t.created_at)) / 86400)
             FILTER (WHERE t.status = 'done')::text AS avg_cycle,
           count(DISTINCT t.id) FILTER (
             WHERE t.status NOT IN ('done','cancelled') AND t.due_date < CURRENT_DATE
           )::text AS overdue
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id AND u.is_active
      LEFT JOIN task_assignees ta ON ta.user_id = u.id
      LEFT JOIN tasks t ON t.id = ta.task_id AND t.team_id = $1
           AND (t.completed_at IS NULL OR t.completed_at::date BETWEEN $2::date AND $3::date)
      LEFT JOIN work_logs wl ON wl.user_id = u.id AND wl.logged_on BETWEEN $2::date AND $3::date
     WHERE tm.team_id = $1
     GROUP BY u.id, u.display_name
     ORDER BY u.display_name
    `,
    [teamId, from, to],
  );

  return {
    teamId,
    generatedAt: new Date().toISOString(),
    rows: rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      completedTasks: Number(row.completed),
      loggedHours: Number(row.logged),
      avgCycleTimeDays: row.avg_cycle ? Math.round(Number(row.avg_cycle) * 10) / 10 : 0,
      overdueTasks: Number(row.overdue),
    })),
  };
}

export type ReportName =
  | 'workload'
  | 'utilization'
  | 'completion-trend'
  | 'overdue'
  | 'productivity'
  | 'assignment-history';

export function assertKnownReport(name: string): ReportName {
  const known: ReportName[] = [
    'workload',
    'utilization',
    'completion-trend',
    'overdue',
    'productivity',
    'assignment-history',
  ];
  if (!known.includes(name as ReportName)) {
    throw ApiError.badRequest(`Unknown report '${name}'`, { known });
  }
  return name as ReportName;
}
