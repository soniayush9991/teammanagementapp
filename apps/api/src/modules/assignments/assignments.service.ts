import {
  isoWeekKey,
  recommendAssignees,
  type AssigneeCandidate,
  type AssigneeRecommendation,
  type MemberCapacity,
  type Task,
} from '@teamspace/shared';
import { query, queryOne, queryRows, withTransaction } from '../../db/pool.js';
import { recordAudit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import type { AuthenticatedActor } from '../../middleware/auth.js';
import { assertCanReadTask, assertTeamManager, loadTaskScope } from '../../middleware/scope.js';
import { publishToTeam, publishToUsers } from '../../realtime/bus.js';
import { notify } from '../notifications/notifications.service.js';
import { loadMemberCapacity } from '../capacity/capacity.service.js';
import { TASK_SELECT, toTask, type TaskRow } from '../tasks/tasks.mapper.js';

async function loadTask(taskId: string): Promise<Task> {
  const row = await queryOne<TaskRow>(`SELECT ${TASK_SELECT} FROM tasks t WHERE t.id = $1`, [taskId]);
  if (!row) throw ApiError.notFound('Task');
  return toTask(row);
}

/**
 * Replaces a task's assignees wholesale. Recorded in assignment_events so the
 * assignment history report can show who moved work and when.
 */
export async function setAssignees(
  actor: AuthenticatedActor,
  taskIdOrKey: string,
  userIds: string[],
  allocations?: Record<string, number>,
): Promise<Task> {
  // Read access first: someone who cannot see the task must be refused
  // outright, not fall through to a validation error that would confirm the
  // task exists.
  const scope = await assertCanReadTask(actor, taskIdOrKey);
  const isSelfAssignOnly = userIds.length === 1 && userIds[0] === actor.id;
  if (!scope.isTeamManager && !isSelfAssignOnly) {
    throw ApiError.forbidden('Only the team manager can assign work to other people');
  }

  const targets = [...new Set(userIds)];
  // Everyone assigned must actually be on the team that owns the task.
  if (targets.length > 0) {
    const eligible = await queryRows<{ user_id: string }>(
      `
      SELECT tm.user_id FROM team_members tm
       JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = $1 AND tm.user_id = ANY($2::uuid[]) AND u.is_active
      `,
      [scope.teamId, targets],
    );
    const eligibleIds = new Set(eligible.map((row) => row.user_id));
    const ineligible = targets.filter((id) => !eligibleIds.has(id));
    if (ineligible.length > 0) {
      throw ApiError.unprocessable('Some assignees are not active members of this team', { ineligible });
    }
  }

  const { task, added, removed } = await withTransaction(async (client) => {
    const { rows: previousRows } = await client.query<{ user_id: string }>(
      'SELECT user_id FROM task_assignees WHERE task_id = $1',
      [scope.taskId],
    );
    const previous = previousRows.map((row) => row.user_id);
    const { rows: estimateRows } = await client.query<{ estimated_hours: string; remaining_hours: string }>(
      'SELECT estimated_hours, remaining_hours FROM tasks WHERE id = $1',
      [scope.taskId],
    );
    const remaining = Number(estimateRows[0]?.remaining_hours ?? 0);

    await client.query('DELETE FROM task_assignees WHERE task_id = $1', [scope.taskId]);

    if (targets.length > 0) {
      const evenShare = Math.round((remaining / targets.length) * 100) / 100;
      for (const userId of targets) {
        await client.query(
          `INSERT INTO task_assignees (task_id, user_id, allocated_hours, assigned_by) VALUES ($1, $2, $3, $4)`,
          [scope.taskId, userId, allocations?.[userId] ?? evenShare, actor.id],
        );
      }
    }

    const addedIds = targets.filter((id) => !previous.includes(id));
    const removedIds = previous.filter((id) => !targets.includes(id));

    for (const userId of addedIds) {
      await client.query(
        `INSERT INTO assignment_events (task_id, user_id, actor_id, action, from_user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          scope.taskId,
          userId,
          actor.id,
          removedIds.length > 0 ? 'reassigned' : 'assigned',
          removedIds[0] ?? null,
        ],
      );
    }
    for (const userId of removedIds) {
      if (targets.length === 0) {
        await client.query(
          `INSERT INTO assignment_events (task_id, user_id, actor_id, action) VALUES ($1, $2, $3, 'unassigned')`,
          [scope.taskId, userId, actor.id],
        );
      }
    }

    await client.query(
      `INSERT INTO task_activity (task_id, actor_id, action, field, from_value, to_value)
       VALUES ($1, $2, 'assigned', 'assignees', $3, $4)`,
      [scope.taskId, actor.id, previous.join(',') || null, targets.join(',') || null],
    );
    await recordAudit(
      {
        orgId: actor.orgId,
        actorId: actor.id,
        action: 'task.assignees_changed',
        entityType: 'task',
        entityId: scope.taskId,
        metadata: { from: previous, to: targets },
      },
      client,
    );

    const { rows } = await client.query<TaskRow>(`SELECT ${TASK_SELECT} FROM tasks t WHERE t.id = $1`, [
      scope.taskId,
    ]);
    const row = rows[0];
    if (!row) throw ApiError.notFound('Task');
    return { task: toTask(row), added: addedIds, removed: removedIds };
  });

  publishToTeam(
    task.teamId,
    { type: 'task.assigned', task, assigneeIds: added, unassignedIds: removed },
    actor.id,
  );
  const week = isoWeekKey(new Date());
  for (const userId of [...added, ...removed]) {
    publishToUsers([userId], { type: 'capacity.changed', userId, weekKey: week });
  }
  if (added.length > 0) {
    await notify({
      orgId: actor.orgId,
      userIds: added,
      kind: 'task_assigned',
      title: `${task.key} was assigned to you`,
      body: task.title,
      link: `/tasks/${task.key}`,
      entityType: 'task',
      entityId: task.id,
      actorId: actor.id,
    });
  }

  return task;
}

/** Drag-and-drop on the planner: move a task from one person to another. */
export async function moveAssignment(
  actor: AuthenticatedActor,
  taskIdOrKey: string,
  fromUserId: string,
  toUserId: string,
): Promise<Task> {
  const scope = await loadTaskScope(actor, taskIdOrKey);
  await assertTeamManager(actor, scope.teamId);

  const current = await queryRows<{ user_id: string }>('SELECT user_id FROM task_assignees WHERE task_id = $1', [
    scope.taskId,
  ]);
  const currentIds = current.map((row) => row.user_id);
  if (!currentIds.includes(fromUserId)) {
    throw ApiError.unprocessable('That task is not assigned to the person it is being moved from');
  }
  const next = [...new Set(currentIds.filter((id) => id !== fromUserId).concat(toUserId))];
  return setAssignees(actor, scope.taskId, next);
}

export interface BulkAssignResult {
  assigned: string[];
  failed: { taskId: string; reason: string }[];
}

/** Assigns many tasks in one action; partial failures are reported, not fatal. */
export async function bulkAssign(
  actor: AuthenticatedActor,
  taskIds: string[],
  userIds: string[],
): Promise<BulkAssignResult> {
  const result: BulkAssignResult = { assigned: [], failed: [] };
  for (const taskId of taskIds) {
    try {
      const task = await setAssignees(actor, taskId, userIds);
      result.assigned.push(task.key);
    } catch (error) {
      result.failed.push({
        taskId,
        reason: error instanceof ApiError ? error.message : 'Unexpected error',
      });
    }
  }
  return result;
}

export interface WorkloadComparison {
  weekKey: string;
  members: MemberCapacity[];
  /** What each member's week would look like if the task landed on them. */
  projections: {
    userId: string;
    projectedPlannedHours: number;
    projectedUtilization: number;
    band: string;
  }[];
}

/**
 * Side-by-side view a manager sees before assigning: current load plus what
 * the candidate's week becomes if they take this task.
 */
export async function compareWorkloads(
  actor: AuthenticatedActor,
  teamId: string,
  weekKey: string,
  estimatedHours: number,
): Promise<WorkloadComparison> {
  await assertTeamManager(actor, teamId);
  const members = await queryRows<{ user_id: string }>(
    `SELECT tm.user_id FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = $1 AND u.is_active`,
    [teamId],
  );
  const snapshots = await loadMemberCapacity(
    actor.orgId,
    members.map((member) => member.user_id),
    weekKey,
  );

  const recommendations = recommendAssignees(
    snapshots.map(toCandidate),
    { estimatedHours },
  );

  return {
    weekKey,
    members: snapshots,
    projections: recommendations.map((recommendation) => {
      const snapshot = snapshots.find((item) => item.userId === recommendation.userId);
      return {
        userId: recommendation.userId,
        projectedPlannedHours: Math.round(((snapshot?.capacity.plannedHours ?? 0) + estimatedHours) * 100) / 100,
        projectedUtilization: recommendation.projectedUtilization,
        band: recommendation.band,
      };
    }),
  };
}

function toCandidate(member: MemberCapacity): AssigneeCandidate {
  return {
    userId: member.userId,
    displayName: member.displayName,
    skills: member.skills,
    capacity: member.capacity,
    openTaskCount: member.openTaskCount,
  };
}

/**
 * Suggests who should take a task, blending skill match with the bandwidth
 * they would have left. The ranking itself lives in the shared package so the
 * client can preview the same result while dragging.
 */
export async function recommendForTask(
  actor: AuthenticatedActor,
  options: { taskIdOrKey?: string; teamId?: string; requiredSkills?: string[]; estimatedHours?: number; weekKey?: string; limit: number },
): Promise<{ weekKey: string; recommendations: AssigneeRecommendation[] }> {
  let teamId = options.teamId;
  let requiredSkills = options.requiredSkills ?? [];
  let estimatedHours = options.estimatedHours ?? 0;
  let dueWeek = options.weekKey ?? isoWeekKey(new Date());

  if (options.taskIdOrKey) {
    const scope = await loadTaskScope(actor, options.taskIdOrKey);
    teamId = scope.teamId;
    const task = await loadTask(scope.taskId);
    // Prefer remaining effort; fall back to the original estimate.
    estimatedHours = options.estimatedHours ?? (task.remainingHours || task.estimatedHours);
    // A task's labels double as its skill requirements when none are given.
    requiredSkills = options.requiredSkills ?? task.labels;
    if (task.dueDate && !options.weekKey) dueWeek = isoWeekKey(new Date(task.dueDate));
  }

  if (!teamId) throw ApiError.badRequest('Provide either a task or a team to recommend within');
  await assertTeamManager(actor, teamId);

  const members = await queryRows<{ user_id: string }>(
    `SELECT tm.user_id FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = $1 AND u.is_active`,
    [teamId],
  );
  const snapshots = await loadMemberCapacity(
    actor.orgId,
    members.map((member) => member.user_id),
    dueWeek,
  );

  const recommendations = recommendAssignees(snapshots.map(toCandidate), {
    requiredSkills,
    estimatedHours,
  });

  return { weekKey: dueWeek, recommendations: recommendations.slice(0, options.limit) };
}

export interface AssignmentHistoryEntry {
  id: string;
  taskKey: string;
  taskTitle: string;
  action: string;
  userId: string | null;
  userName: string | null;
  fromUserName: string | null;
  actorName: string | null;
  createdAt: string;
}

export async function assignmentHistory(
  actor: AuthenticatedActor,
  filter: { teamId?: string; userId?: string; from?: string; to?: string; limit: number },
): Promise<AssignmentHistoryEntry[]> {
  const conditions = ['t.org_id = $1'];
  const params: unknown[] = [actor.orgId];

  if (filter.teamId) {
    await assertTeamManager(actor, filter.teamId);
    params.push(filter.teamId);
    conditions.push(`t.team_id = $${params.length}`);
  } else {
    // Without a team filter, restrict to teams the actor manages.
    params.push(actor.id, actor.role);
    conditions.push(
      `($${params.length} = 'admin' OR EXISTS (SELECT 1 FROM teams tt WHERE tt.id = t.team_id AND tt.manager_id = $${params.length - 1}))`,
    );
  }
  if (filter.userId) {
    params.push(filter.userId);
    conditions.push(`ae.user_id = $${params.length}`);
  }
  if (filter.from) {
    params.push(filter.from);
    conditions.push(`ae.created_at >= $${params.length}::date`);
  }
  if (filter.to) {
    params.push(filter.to);
    conditions.push(`ae.created_at < ($${params.length}::date + INTERVAL '1 day')`);
  }
  params.push(filter.limit);

  const rows = await queryRows<{
    id: string;
    task_key: string;
    task_title: string;
    action: string;
    user_id: string | null;
    user_name: string | null;
    from_user_name: string | null;
    actor_name: string | null;
    created_at: Date;
  }>(
    `
    SELECT ae.id::text AS id, t.key AS task_key, t.title AS task_title, ae.action, ae.user_id,
           tu.display_name AS user_name, fu.display_name AS from_user_name, au.display_name AS actor_name,
           ae.created_at
      FROM assignment_events ae
      JOIN tasks t ON t.id = ae.task_id
      LEFT JOIN users tu ON tu.id = ae.user_id
      LEFT JOIN users fu ON fu.id = ae.from_user_id
      LEFT JOIN users au ON au.id = ae.actor_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY ae.created_at DESC
     LIMIT $${params.length}
    `,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    taskKey: row.task_key,
    taskTitle: row.task_title,
    action: row.action,
    userId: row.user_id,
    userName: row.user_name,
    fromUserName: row.from_user_name,
    actorName: row.actor_name,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function updateAllocation(
  actor: AuthenticatedActor,
  taskIdOrKey: string,
  userId: string,
  allocatedHours: number,
): Promise<Task> {
  const scope = await loadTaskScope(actor, taskIdOrKey);
  if (!scope.isTeamManager && actor.id !== userId) {
    throw ApiError.forbidden('Only the team manager can change someone else\'s allocation');
  }
  const { rowCount } = await query(
    'UPDATE task_assignees SET allocated_hours = $3 WHERE task_id = $1 AND user_id = $2',
    [scope.taskId, userId, allocatedHours],
  );
  if (!rowCount) throw ApiError.notFound('Assignment');
  publishToUsers([userId], { type: 'capacity.changed', userId, weekKey: isoWeekKey(new Date()) });
  return loadTask(scope.taskId);
}
