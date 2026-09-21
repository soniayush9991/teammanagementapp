import {
  computeCapacity,
  isoWeekKey,
  parseIsoWeekKey,
  rollupTeamCapacity,
  workingDaysInWeek,
  type CapacitySnapshot,
  type LeaveEntry,
  type LeaveKind,
  type MemberCapacity,
  type TeamCapacityView,
} from '@teamspace/shared';
import { query, queryOne, queryRows, withTransaction } from '../../db/pool.js';
import { recordAudit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import type { AuthenticatedActor } from '../../middleware/auth.js';
import { assertCanViewUser, assertTeamMember, isInReportingLine, loadTeamScope } from '../../middleware/scope.js';
import { publishToUsers } from '../../realtime/bus.js';
import { notify } from '../notifications/notifications.service.js';

interface RawLoadRow {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  job_title: string | null;
  weekly_capacity_hours: string;
  override_hours: string | null;
  skills: string[];
  planned_hours: string | null;
  open_task_count: string;
  overdue_task_count: string;
  leave_start: Date | null;
  leave_end: Date | null;
  leave_hours_per_day: string | null;
  holiday_hours: string | null;
}

/**
 * The one query behind every capacity view. For a set of users and one ISO
 * week it returns contracted capacity (with any per-week override), planned
 * load from open assignments due that week, approved leave overlapping the
 * week, and public holidays.
 */
const LOAD_QUERY = `
WITH week AS (
  SELECT $2::date AS week_start, ($2::date + INTERVAL '6 days')::date AS week_end, $3::text AS week_key
),
target_users AS (
  SELECT u.id, u.display_name, u.avatar_url, u.job_title, u.weekly_capacity_hours
    FROM users u
   WHERE u.id = ANY($1::uuid[]) AND u.is_active
),
planned AS (
  SELECT ta.user_id,
         sum(CASE WHEN ta.allocated_hours > 0 THEN ta.allocated_hours ELSE t.remaining_hours END) AS planned_hours,
         count(*) AS open_task_count,
         count(*) FILTER (WHERE t.due_date < CURRENT_DATE) AS overdue_task_count
    FROM task_assignees ta
    JOIN tasks t ON t.id = ta.task_id
    CROSS JOIN week w
   WHERE t.status NOT IN ('done','cancelled')
     -- Undated work is counted against the current week so it is never hidden.
     AND (
       (t.due_date IS NOT NULL AND t.due_date BETWEEN w.week_start AND w.week_end)
       OR (t.due_date IS NULL AND w.week_key = to_char(CURRENT_DATE, 'IYYY-"W"IW'))
       OR (t.due_date < w.week_start AND w.week_key = to_char(CURRENT_DATE, 'IYYY-"W"IW'))
     )
     AND ta.user_id = ANY($1::uuid[])
   GROUP BY ta.user_id
),
leave AS (
  SELECT lr.user_id, lr.start_date AS leave_start, lr.end_date AS leave_end, lr.hours_per_day
    FROM leave_requests lr
    CROSS JOIN week w
   WHERE lr.status = 'approved'
     AND lr.user_id = ANY($1::uuid[])
     AND lr.start_date <= w.week_end
     AND lr.end_date >= w.week_start
),
holiday AS (
  SELECT sum(h.hours) AS holiday_hours
    FROM holidays h
    CROSS JOIN week w
   WHERE h.org_id = $4 AND h.day BETWEEN w.week_start AND w.week_end
     AND extract(isodow FROM h.day) <= 5
)
SELECT tu.id AS user_id, tu.display_name, tu.avatar_url, tu.job_title, tu.weekly_capacity_hours,
       cw.capacity_hours AS override_hours,
       COALESCE((SELECT array_agg(s.name::text ORDER BY s.name)
                   FROM user_skills us JOIN skills s ON s.id = us.skill_id
                  WHERE us.user_id = tu.id), '{}') AS skills,
       p.planned_hours,
       COALESCE(p.open_task_count, 0) AS open_task_count,
       COALESCE(p.overdue_task_count, 0) AS overdue_task_count,
       l.leave_start, l.leave_end, l.hours_per_day AS leave_hours_per_day,
       (SELECT holiday_hours FROM holiday) AS holiday_hours
  FROM target_users tu
  LEFT JOIN capacity_weeks cw ON cw.user_id = tu.id AND cw.week_key = $3
  LEFT JOIN planned p ON p.user_id = tu.id
  LEFT JOIN leave l ON l.user_id = tu.id
 ORDER BY tu.display_name
`;

/**
 * Collapses the (possibly multiple) leave rows per user into hours, then runs
 * the shared capacity formula. Leave hours are computed from working days so
 * a Fri-Mon holiday costs two days, not four.
 */
export async function loadMemberCapacity(
  orgId: string,
  userIds: string[],
  weekKey: string,
): Promise<MemberCapacity[]> {
  if (userIds.length === 0) return [];
  const { start } = parseIsoWeekKey(weekKey);
  const rows = await queryRows<RawLoadRow>(LOAD_QUERY, [
    userIds,
    start.toISOString().slice(0, 10),
    weekKey,
    orgId,
  ]);

  const byUser = new Map<string, { row: RawLoadRow; leaveHours: number }>();
  for (const row of rows) {
    const existing = byUser.get(row.user_id);
    const leaveHours =
      row.leave_start && row.leave_end
        ? workingDaysInWeek(start, row.leave_start, row.leave_end) * Number(row.leave_hours_per_day ?? 8)
        : 0;
    if (existing) {
      // Several overlapping leave rows in one week add up.
      existing.leaveHours += leaveHours;
    } else {
      byUser.set(row.user_id, { row, leaveHours });
    }
  }

  return [...byUser.values()].map(({ row, leaveHours }) => {
    const weeklyCapacityHours = Number(row.override_hours ?? row.weekly_capacity_hours);
    const holidayHours = Number(row.holiday_hours ?? 0);
    const capacity = computeCapacity({
      weeklyCapacityHours,
      leaveHours: leaveHours + holidayHours,
      plannedHours: Number(row.planned_hours ?? 0),
    });

    return {
      userId: row.user_id,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      jobTitle: row.job_title,
      skills: row.skills ?? [],
      weekKey,
      capacity,
      openTaskCount: Number(row.open_task_count),
      overdueTaskCount: Number(row.overdue_task_count),
    };
  });
}

export async function getUserCapacity(
  actor: AuthenticatedActor,
  userId: string,
  weekKey: string,
): Promise<MemberCapacity> {
  await assertCanViewUser(actor, userId);
  const [snapshot] = await loadMemberCapacity(actor.orgId, [userId], weekKey);
  if (!snapshot) throw ApiError.notFound('Capacity data');
  return snapshot;
}

export async function getTeamCapacity(
  actor: AuthenticatedActor,
  teamId: string,
  weekKey: string,
): Promise<TeamCapacityView> {
  await assertTeamMember(actor, teamId);
  const members = await queryRows<{ user_id: string }>(
    `SELECT tm.user_id FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = $1 AND u.is_active`,
    [teamId],
  );
  const snapshots = await loadMemberCapacity(
    actor.orgId,
    members.map((member) => member.user_id),
    weekKey,
  );
  return {
    teamId,
    weekKey,
    members: snapshots,
    rollup: rollupTeamCapacity(snapshots.map((snapshot) => snapshot.capacity)),
  };
}

/** Several weeks at once, for the planner's horizon view. */
export async function getCapacityHorizon(
  actor: AuthenticatedActor,
  teamId: string,
  weeks: number,
): Promise<TeamCapacityView[]> {
  await assertTeamMember(actor, teamId);
  const keys: string[] = [];
  const cursor = new Date();
  for (let index = 0; index < weeks; index += 1) {
    keys.push(isoWeekKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return Promise.all(keys.map((weekKey) => getTeamCapacity(actor, teamId, weekKey)));
}

export async function setWeeklyCapacityOverride(
  actor: AuthenticatedActor,
  userId: string,
  weekKey: string,
  capacityHours: number,
  note?: string,
): Promise<MemberCapacity> {
  const isSelf = actor.id === userId;
  if (!isSelf && actor.role !== 'admin' && !(await isInReportingLine(actor, userId))) {
    throw ApiError.forbidden('You cannot change this person\'s capacity');
  }
  // A person can flex their own week, but only a manager can change the
  // contracted baseline (users.weekly_capacity_hours).
  await query(
    `
    INSERT INTO capacity_weeks (user_id, week_key, capacity_hours, note, updated_by)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id, week_key)
      DO UPDATE SET capacity_hours = EXCLUDED.capacity_hours, note = EXCLUDED.note,
                    updated_by = EXCLUDED.updated_by, updated_at = now()
    `,
    [userId, weekKey, capacityHours, note ?? null, actor.id],
  );
  publishToUsers([userId], { type: 'capacity.changed', userId, weekKey });
  return getUserCapacity(actor, userId, weekKey);
}

export async function requestLeave(
  actor: AuthenticatedActor,
  input: { userId?: string; kind: LeaveKind; startDate: string; endDate: string; hoursPerDay: number; note?: string },
): Promise<LeaveEntry> {
  const userId = input.userId ?? actor.id;
  if (userId !== actor.id && actor.role !== 'admin' && !(await isInReportingLine(actor, userId))) {
    throw ApiError.forbidden('You cannot file leave for this person');
  }

  const overlapping = await queryOne<{ count: string }>(
    `
    SELECT count(*)::text AS count FROM leave_requests
     WHERE user_id = $1 AND status IN ('pending','approved')
       AND start_date <= $3::date AND end_date >= $2::date
    `,
    [userId, input.startDate, input.endDate],
  );
  if (Number(overlapping?.count ?? 0) > 0) {
    throw ApiError.conflict('That range overlaps leave that is already booked or pending');
  }

  const row = await queryOne<{ id: string }>(
    `
    INSERT INTO leave_requests (user_id, kind, start_date, end_date, hours_per_day, note)
    VALUES ($1, $2::leave_kind, $3, $4, $5, $6)
    RETURNING id
    `,
    [userId, input.kind, input.startDate, input.endDate, input.hoursPerDay, input.note ?? null],
  );
  if (!row) throw ApiError.internal('Could not file the leave request');

  // The approver is the person's manager.
  const manager = await queryOne<{ manager_id: string | null; display_name: string }>(
    'SELECT manager_id, display_name FROM users WHERE id = $1',
    [userId],
  );
  if (manager?.manager_id) {
    await notify({
      orgId: actor.orgId,
      userIds: [manager.manager_id],
      kind: 'group_invitation',
      title: `${manager.display_name} requested leave`,
      body: `${input.startDate} to ${input.endDate}`,
      link: '/capacity?tab=leave',
      entityType: 'leave_request',
      entityId: row.id,
      actorId: actor.id,
    });
  }

  return {
    id: row.id,
    userId,
    kind: input.kind,
    status: 'pending',
    startDate: input.startDate,
    endDate: input.endDate,
    hoursPerDay: input.hoursPerDay,
    note: input.note ?? null,
  };
}

export async function decideLeave(
  actor: AuthenticatedActor,
  leaveId: string,
  decision: 'approved' | 'rejected',
): Promise<LeaveEntry> {
  const leave = await queryOne<{ user_id: string }>('SELECT user_id FROM leave_requests WHERE id = $1', [leaveId]);
  if (!leave) throw ApiError.notFound('Leave request');
  if (actor.role !== 'admin' && !(await isInReportingLine(actor, leave.user_id))) {
    throw ApiError.forbidden('Only this person\'s manager can decide their leave');
  }
  if (leave.user_id === actor.id && actor.role !== 'admin') {
    throw ApiError.forbidden('You cannot approve your own leave');
  }

  const row = await withTransaction(async (client) => {
    const { rows } = await client.query<{
      id: string;
      user_id: string;
      kind: LeaveKind;
      status: 'approved' | 'rejected';
      start_date: Date;
      end_date: Date;
      hours_per_day: string;
      note: string | null;
    }>(
      `
      UPDATE leave_requests
         SET status = $2::leave_status, decided_by = $3, decided_at = now()
       WHERE id = $1 AND status = 'pending'
      RETURNING id, user_id, kind, status, start_date, end_date, hours_per_day, note
      `,
      [leaveId, decision, actor.id],
    );
    const updated = rows[0];
    if (!updated) throw ApiError.conflict('That leave request has already been decided');

    await recordAudit(
      {
        orgId: actor.orgId,
        actorId: actor.id,
        action: `leave.${decision}`,
        entityType: 'leave_request',
        entityId: leaveId,
        metadata: { userId: updated.user_id },
      },
      client,
    );
    return updated;
  });

  // Approved leave reduces capacity, so the affected weeks must refresh.
  publishToUsers([row.user_id], {
    type: 'capacity.changed',
    userId: row.user_id,
    weekKey: isoWeekKey(row.start_date),
  });

  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    startDate: row.start_date.toISOString().slice(0, 10),
    endDate: row.end_date.toISOString().slice(0, 10),
    hoursPerDay: Number(row.hours_per_day),
    note: row.note,
  };
}

export async function listLeave(
  actor: AuthenticatedActor,
  filter: { userId?: string; teamId?: string; from?: string; to?: string; status?: string },
): Promise<LeaveEntry[]> {
  const conditions: string[] = ['u.org_id = $1'];
  const params: unknown[] = [actor.orgId];

  if (filter.userId) {
    await assertCanViewUser(actor, filter.userId);
    params.push(filter.userId);
    conditions.push(`lr.user_id = $${params.length}`);
  } else if (filter.teamId) {
    await loadTeamScope(actor, filter.teamId);
    params.push(filter.teamId);
    conditions.push(`EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = lr.user_id AND tm.team_id = $${params.length})`);
  } else {
    // Default to what the actor is entitled to: their own leave, their direct
    // reports' leave, or everything when they are an admin.
    params.push(actor.id);
    const selfParam = params.length;
    params.push(actor.role);
    const roleParam = params.length;
    conditions.push(
      `(lr.user_id = $${selfParam} OR u.manager_id = $${selfParam} OR $${roleParam} = 'admin')`,
    );
  }

  if (filter.from) {
    params.push(filter.from);
    conditions.push(`lr.end_date >= $${params.length}::date`);
  }
  if (filter.to) {
    params.push(filter.to);
    conditions.push(`lr.start_date <= $${params.length}::date`);
  }
  if (filter.status) {
    params.push(filter.status);
    conditions.push(`lr.status = $${params.length}::leave_status`);
  }

  const rows = await queryRows<{
    id: string;
    user_id: string;
    kind: LeaveKind;
    status: LeaveEntry['status'];
    start_date: Date;
    end_date: Date;
    hours_per_day: string;
    note: string | null;
  }>(
    `
    SELECT lr.id, lr.user_id, lr.kind, lr.status, lr.start_date, lr.end_date, lr.hours_per_day, lr.note
      FROM leave_requests lr
      JOIN users u ON u.id = lr.user_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY lr.start_date DESC
     LIMIT 200
    `,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    startDate: row.start_date.toISOString().slice(0, 10),
    endDate: row.end_date.toISOString().slice(0, 10),
    hoursPerDay: Number(row.hours_per_day),
    note: row.note,
  }));
}

export async function currentWeekKey(): Promise<string> {
  return isoWeekKey(new Date());
}

export type { CapacitySnapshot };
