import type { PoolClient } from 'pg';
import {
  OPEN_TASK_STATUSES,
  isoWeekKey,
  type DependencyType,
  type Task,
  type TaskActivityEntry,
  type TaskComment,
  type TaskPriority,
  type TaskStatus,
  type RecurrenceFrequency,
} from '@teamspace/shared';
import { query, queryOne, queryRows, withTransaction } from '../../db/pool.js';
import { recordAudit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/http.js';
import type { AuthenticatedActor } from '../../middleware/auth.js';
import {
  assertCanReadTask,
  assertCanWriteTask,
  assertTeamMember,
  loadTaskScope,
} from '../../middleware/scope.js';
import { publishToTeam, publishToUsers } from '../../realtime/bus.js';
import { notify } from '../notifications/notifications.service.js';
import { TASK_SELECT, toTask, type TaskRow } from './tasks.mapper.js';
import { isRecurrenceExhausted, nextOccurrence } from './recurrence.js';

/** Which status changes are legal. Keeps the board from producing nonsense. */
const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ['todo', 'in_progress', 'cancelled'],
  todo: ['backlog', 'in_progress', 'blocked', 'cancelled'],
  in_progress: ['todo', 'in_review', 'blocked', 'done', 'cancelled'],
  in_review: ['in_progress', 'blocked', 'done', 'cancelled'],
  blocked: ['todo', 'in_progress', 'cancelled'],
  done: ['in_progress'],
  cancelled: ['backlog', 'todo'],
};

export function assertTransitionAllowed(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw ApiError.unprocessable(`A task cannot move from ${from} to ${to}`, {
      allowed: ALLOWED_TRANSITIONS[from],
    });
  }
}

export interface TaskFilter {
  teamId?: string;
  assigneeId?: string;
  status?: TaskStatus[];
  priority?: TaskPriority[];
  label?: string;
  dueBefore?: string;
  dueAfter?: string;
  parentTaskId?: string | null;
  includeSubtasks: boolean;
  overdueOnly: boolean;
  search?: string;
  limit: number;
  cursor?: string;
}

/**
 * Lists tasks the actor may see: anything in their teams, plus anything
 * assigned to them. Keyset pagination on (created_at, id) so paging stays
 * stable while new tasks arrive.
 */
export async function listTasks(
  actor: AuthenticatedActor,
  filter: TaskFilter,
): Promise<{ items: Task[]; nextCursor: string | null }> {
  const conditions = [
    't.org_id = $1',
    `(EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.team_id AND tm.user_id = $2)
      OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $2)
      OR $3 = 'admin')`,
  ];
  const params: unknown[] = [actor.orgId, actor.id, actor.role];

  if (filter.teamId) {
    params.push(filter.teamId);
    conditions.push(`t.team_id = $${params.length}`);
  }
  if (filter.assigneeId) {
    params.push(filter.assigneeId);
    conditions.push(`EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $${params.length})`);
  }
  if (filter.status?.length) {
    params.push(filter.status);
    conditions.push(`t.status = ANY($${params.length}::task_status[])`);
  }
  if (filter.priority?.length) {
    params.push(filter.priority);
    conditions.push(`t.priority = ANY($${params.length}::task_priority[])`);
  }
  if (filter.label) {
    params.push(filter.label);
    conditions.push(
      `EXISTS (SELECT 1 FROM task_labels tl JOIN labels l ON l.id = tl.label_id
                WHERE tl.task_id = t.id AND l.name = $${params.length}::citext)`,
    );
  }
  if (filter.dueBefore) {
    params.push(filter.dueBefore);
    conditions.push(`t.due_date <= $${params.length}::date`);
  }
  if (filter.dueAfter) {
    params.push(filter.dueAfter);
    conditions.push(`t.due_date >= $${params.length}::date`);
  }
  if (filter.parentTaskId) {
    params.push(filter.parentTaskId);
    conditions.push(`t.parent_task_id = $${params.length}`);
  } else if (!filter.includeSubtasks) {
    conditions.push('t.parent_task_id IS NULL');
  }
  if (filter.overdueOnly) {
    conditions.push(`t.due_date < CURRENT_DATE AND t.status NOT IN ('done','cancelled')`);
  }
  if (filter.search) {
    params.push(filter.search);
    conditions.push(`t.search_vector @@ websearch_to_tsquery('english', $${params.length})`);
  }
  if (filter.cursor) {
    const cursor = decodeCursor(filter.cursor);
    params.push(cursor.createdAt, cursor.id);
    conditions.push(`(t.created_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }

  params.push(filter.limit + 1);
  const rows = await queryRows<TaskRow>(
    `
    SELECT ${TASK_SELECT}
      FROM tasks t
     WHERE ${conditions.join(' AND ')}
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT $${params.length}
    `,
    params,
  );

  const hasMore = rows.length > filter.limit;
  const page = hasMore ? rows.slice(0, filter.limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map(toTask),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}

export async function getTask(actor: AuthenticatedActor, taskIdOrKey: string): Promise<Task> {
  const scope = await assertCanReadTask(actor, taskIdOrKey);
  const row = await queryOne<TaskRow>(`SELECT ${TASK_SELECT} FROM tasks t WHERE t.id = $1`, [scope.taskId]);
  if (!row) throw ApiError.notFound('Task');
  return toTask(row);
}

export interface CreateTaskInput {
  teamId: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  parentTaskId?: string | null;
  assigneeIds?: string[];
  startDate?: string | null;
  dueDate?: string | null;
  estimatedHours?: number;
  labels?: string[];
  recurrence?: { frequency: RecurrenceFrequency; interval: number; until?: string | null } | null;
}

export async function createTask(actor: AuthenticatedActor, input: CreateTaskInput): Promise<Task> {
  await assertTeamMember(actor, input.teamId);

  // Assigning to someone else is a manager action; assigning to yourself is not.
  const assigneeIds = [...new Set(input.assigneeIds ?? [])];
  if (assigneeIds.some((id) => id !== actor.id)) {
    await assertTeamMember(actor, input.teamId);
    const scope = await loadTaskScopeForTeam(actor, input.teamId);
    if (!scope.isManager) throw ApiError.forbidden('Only the team manager can assign work to other people');
  }

  if (input.parentTaskId) {
    const parent = await queryOne<{ parent_task_id: string | null; team_id: string }>(
      'SELECT parent_task_id, team_id FROM tasks WHERE id = $1 AND org_id = $2',
      [input.parentTaskId, actor.orgId],
    );
    if (!parent) throw ApiError.notFound('Parent task');
    if (parent.parent_task_id) throw ApiError.unprocessable('Subtasks cannot be nested further');
    if (parent.team_id !== input.teamId) throw ApiError.unprocessable('A subtask must live in the parent\'s team');
  }

  const estimatedHours = input.estimatedHours ?? 0;

  const task = await withTransaction(async (client) => {
    const { rows: keyRows } = await client.query<{ key: string }>('SELECT next_task_key($1) AS key', [input.teamId]);
    const key = keyRows[0]?.key;
    if (!key) throw ApiError.internal('Could not allocate a task key');

    const recurrenceNextAt =
      input.recurrence && input.dueDate
        ? nextOccurrence(new Date(input.dueDate), input.recurrence.frequency, input.recurrence.interval)
        : null;

    const { rows } = await client.query<{ id: string }>(
      `
      INSERT INTO tasks (org_id, team_id, key, parent_task_id, title, description, status, priority,
                         created_by, start_date, due_date, estimated_hours, remaining_hours,
                         recurrence_freq, recurrence_interval, recurrence_until, recurrence_next_at,
                         completed_at)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::task_status, 'todo'), COALESCE($8::task_priority, 'medium'),
              $9, $10, $11, $12, $12,
              $13::recurrence_freq, $14, $15, $16,
              CASE WHEN $7::task_status = 'done' THEN now() ELSE NULL END)
      RETURNING id
      `,
      [
        actor.orgId,
        input.teamId,
        key,
        input.parentTaskId ?? null,
        input.title,
        input.description ?? null,
        input.status ?? null,
        input.priority ?? null,
        actor.id,
        input.startDate ?? null,
        input.dueDate ?? null,
        estimatedHours,
        input.recurrence?.frequency ?? null,
        input.recurrence?.interval ?? null,
        input.recurrence?.until ?? null,
        recurrenceNextAt,
      ],
    );
    const created = rows[0];
    if (!created) throw ApiError.internal('Could not create the task');

    if (assigneeIds.length > 0) {
      await applyAssignees(client, created.id, assigneeIds, actor.id, estimatedHours);
    }
    if (input.labels?.length) {
      await applyLabels(client, actor.orgId, created.id, input.labels);
    }

    await client.query(
      `INSERT INTO task_activity (task_id, actor_id, action, to_value) VALUES ($1, $2, 'created', $3)`,
      [created.id, actor.id, input.title],
    );
    await recordAudit(
      {
        orgId: actor.orgId,
        actorId: actor.id,
        action: 'task.created',
        entityType: 'task',
        entityId: created.id,
        metadata: { key, teamId: input.teamId },
      },
      client,
    );

    const { rows: taskRows } = await client.query<TaskRow>(`SELECT ${TASK_SELECT} FROM tasks t WHERE t.id = $1`, [
      created.id,
    ]);
    const taskRow = taskRows[0];
    if (!taskRow) throw ApiError.internal('Could not load the created task');
    return toTask(taskRow);
  });

  publishToTeam(task.teamId, { type: 'task.created', task }, actor.id);
  if (assigneeIds.length > 0) {
    await notifyAssignment(actor, task, assigneeIds);
  }
  return task;
}

async function loadTaskScopeForTeam(
  actor: AuthenticatedActor,
  teamId: string,
): Promise<{ isManager: boolean }> {
  const row = await queryOne<{ manager_id: string }>('SELECT manager_id FROM teams WHERE id = $1', [teamId]);
  return { isManager: actor.role === 'admin' || row?.manager_id === actor.id };
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  startDate?: string | null;
  dueDate?: string | null;
  estimatedHours?: number;
  remainingHours?: number;
  labels?: string[];
}

export async function updateTask(
  actor: AuthenticatedActor,
  taskIdOrKey: string,
  input: UpdateTaskInput,
): Promise<Task> {
  const scope = await assertCanWriteTask(actor, taskIdOrKey);

  const current = await queryOne<{
    status: TaskStatus;
    title: string;
    priority: TaskPriority;
    due_date: Date | null;
    remaining_hours: string;
    recurrence_freq: RecurrenceFrequency | null;
    recurrence_interval: number | null;
    recurrence_until: Date | null;
  }>(
    `SELECT status, title, priority, due_date, remaining_hours, recurrence_freq, recurrence_interval, recurrence_until
       FROM tasks WHERE id = $1`,
    [scope.taskId],
  );
  if (!current) throw ApiError.notFound('Task');

  if (input.status) {
    assertTransitionAllowed(current.status, input.status);
    if (input.status === 'done') {
      // A task cannot be completed while something it depends on is open.
      const blocking = await queryRows<{ key: string }>(
        `
        SELECT bt.key
          FROM task_dependencies d
          JOIN tasks bt ON bt.id = d.depends_on_task_id
         WHERE d.task_id = $1 AND d.type = 'blocks' AND bt.status NOT IN ('done','cancelled')
        `,
        [scope.taskId],
      );
      if (blocking.length > 0) {
        throw ApiError.conflict('This task is blocked by work that is still open', {
          blockedBy: blocking.map((row) => row.key),
        });
      }
      const openSubtasks = await queryOne<{ count: string }>(
        `SELECT count(*)::text AS count FROM tasks WHERE parent_task_id = $1 AND status NOT IN ('done','cancelled')`,
        [scope.taskId],
      );
      if (Number(openSubtasks?.count ?? 0) > 0) {
        throw ApiError.conflict('Close the open subtasks first', {
          openSubtasks: Number(openSubtasks?.count ?? 0),
        });
      }
    }
  }

  const updates: string[] = [];
  const params: unknown[] = [scope.taskId];
  const changedFields: string[] = [];
  const push = (column: string, value: unknown, field: string): void => {
    params.push(value);
    updates.push(`${column} = $${params.length}`);
    changedFields.push(field);
  };

  if (input.title !== undefined) push('title', input.title, 'title');
  if (input.description !== undefined) push('description', input.description, 'description');
  if (input.priority !== undefined) push('priority', input.priority, 'priority');
  if (input.startDate !== undefined) push('start_date', input.startDate, 'startDate');
  if (input.dueDate !== undefined) push('due_date', input.dueDate, 'dueDate');
  if (input.estimatedHours !== undefined) push('estimated_hours', input.estimatedHours, 'estimatedHours');
  if (input.remainingHours !== undefined) push('remaining_hours', input.remainingHours, 'remainingHours');
  if (input.status !== undefined) {
    push('status', input.status, 'status');
    // completed_at and status are kept consistent by a table constraint, so
    // they must move together.
    updates.push(`completed_at = CASE WHEN $${params.length}::task_status = 'done' THEN now() ELSE NULL END`);
    if (input.status === 'done' && input.remainingHours === undefined) {
      updates.push('remaining_hours = 0');
      changedFields.push('remainingHours');
    }
  }

  const task = await withTransaction(async (client) => {
    if (updates.length > 0) {
      await client.query(`UPDATE tasks SET ${updates.join(', ')} WHERE id = $1`, params);
    }
    if (input.labels) {
      await applyLabels(client, actor.orgId, scope.taskId, input.labels);
      changedFields.push('labels');
    }

    // One activity row per changed field is what the timeline renders.
    if (input.status && input.status !== current.status) {
      await client.query(
        `INSERT INTO task_activity (task_id, actor_id, action, field, from_value, to_value)
         VALUES ($1, $2, 'status_changed', 'status', $3, $4)`,
        [scope.taskId, actor.id, current.status, input.status],
      );
    }
    if (input.priority && input.priority !== current.priority) {
      await client.query(
        `INSERT INTO task_activity (task_id, actor_id, action, field, from_value, to_value)
         VALUES ($1, $2, 'updated', 'priority', $3, $4)`,
        [scope.taskId, actor.id, current.priority, input.priority],
      );
    }
    if (input.remainingHours !== undefined && Number(current.remaining_hours) !== input.remainingHours) {
      await client.query(
        `INSERT INTO task_activity (task_id, actor_id, action, field, from_value, to_value)
         VALUES ($1, $2, 'updated', 'remainingHours', $3, $4)`,
        [scope.taskId, actor.id, current.remaining_hours, String(input.remainingHours)],
      );
    }

    // Completing a recurring task spawns the next occurrence.
    if (input.status === 'done' && current.recurrence_freq && current.recurrence_interval) {
      await spawnNextOccurrence(client, scope.taskId, actor.id);
    }

    const { rows } = await client.query<TaskRow>(`SELECT ${TASK_SELECT} FROM tasks t WHERE t.id = $1`, [
      scope.taskId,
    ]);
    const row = rows[0];
    if (!row) throw ApiError.notFound('Task');
    return toTask(row);
  });

  publishToTeam(task.teamId, { type: 'task.updated', task, changedFields }, actor.id);

  const assigneeIds = task.assignees.map((assignee) => assignee.userId);
  if (input.status && input.status !== current.status) {
    for (const userId of assigneeIds) {
      publishToUsers([userId], { type: 'capacity.changed', userId, weekKey: isoWeekKey(new Date()) });
    }
    await notify({
      orgId: actor.orgId,
      userIds: assigneeIds,
      kind: 'task_status_changed',
      title: `${task.key} moved to ${input.status.replace('_', ' ')}`,
      body: task.title,
      link: `/tasks/${task.key}`,
      entityType: 'task',
      entityId: task.id,
      actorId: actor.id,
    });
  }

  return task;
}

/** Copies a completed recurring task forward and stops at the until date. */
async function spawnNextOccurrence(client: PoolClient, taskId: string, actorId: string): Promise<void> {
  const { rows } = await client.query<{
    org_id: string;
    team_id: string;
    title: string;
    description: string | null;
    priority: TaskPriority;
    estimated_hours: string;
    due_date: Date | null;
    recurrence_freq: RecurrenceFrequency;
    recurrence_interval: number;
    recurrence_until: Date | null;
  }>(
    `SELECT org_id, team_id, title, description, priority, estimated_hours, due_date,
            recurrence_freq, recurrence_interval, recurrence_until
       FROM tasks WHERE id = $1`,
    [taskId],
  );
  const template = rows[0];
  if (!template) return;

  const base = template.due_date ?? new Date();
  const next = nextOccurrence(base, template.recurrence_freq, template.recurrence_interval);
  if (isRecurrenceExhausted(next, template.recurrence_until)) {
    // Rule is finished; stop carrying the recurrence on the closed task.
    await client.query(
      `UPDATE tasks SET recurrence_next_at = NULL WHERE id = $1`,
      [taskId],
    );
    return;
  }

  const { rows: keyRows } = await client.query<{ key: string }>('SELECT next_task_key($1) AS key', [
    template.team_id,
  ]);
  const key = keyRows[0]?.key;
  if (!key) return;

  const { rows: createdRows } = await client.query<{ id: string }>(
    `
    INSERT INTO tasks (org_id, team_id, key, title, description, status, priority, created_by,
                       due_date, estimated_hours, remaining_hours,
                       recurrence_freq, recurrence_interval, recurrence_until, recurrence_next_at)
    VALUES ($1, $2, $3, $4, $5, 'todo', $6, $7, $8, $9, $9, $10, $11, $12, $13)
    RETURNING id
    `,
    [
      template.org_id,
      template.team_id,
      key,
      template.title,
      template.description,
      template.priority,
      actorId,
      next.toISOString().slice(0, 10),
      template.estimated_hours,
      template.recurrence_freq,
      template.recurrence_interval,
      template.recurrence_until,
      nextOccurrence(next, template.recurrence_freq, template.recurrence_interval),
    ],
  );
  const created = createdRows[0];
  if (!created) return;

  // Carry the assignees and labels of the occurrence that just closed.
  await client.query(
    `
    INSERT INTO task_assignees (task_id, user_id, allocated_hours, assigned_by)
    SELECT $1, ta.user_id, ta.allocated_hours, $3 FROM task_assignees ta WHERE ta.task_id = $2
    `,
    [created.id, taskId, actorId],
  );
  await client.query(
    `INSERT INTO task_labels (task_id, label_id) SELECT $1, tl.label_id FROM task_labels tl WHERE tl.task_id = $2`,
    [created.id, taskId],
  );
  await client.query(
    `INSERT INTO task_activity (task_id, actor_id, action, to_value) VALUES ($1, $2, 'created_from_recurrence', $3)`,
    [created.id, actorId, key],
  );
  await client.query('UPDATE tasks SET recurrence_next_at = NULL WHERE id = $1', [taskId]);
}

/** Splits the estimate evenly unless the caller allocated hours explicitly. */
async function applyAssignees(
  client: PoolClient,
  taskId: string,
  userIds: string[],
  actorId: string,
  estimatedHours: number,
): Promise<void> {
  const share = userIds.length > 0 ? Math.round((estimatedHours / userIds.length) * 100) / 100 : 0;
  await client.query(
    `
    INSERT INTO task_assignees (task_id, user_id, allocated_hours, assigned_by)
    SELECT $1, unnest($2::uuid[]), $3, $4
    ON CONFLICT (task_id, user_id) DO UPDATE SET allocated_hours = EXCLUDED.allocated_hours
    `,
    [taskId, userIds, share, actorId],
  );
  await client.query(
    `
    INSERT INTO assignment_events (task_id, user_id, actor_id, action)
    SELECT $1, unnest($2::uuid[]), $3, 'assigned'
    `,
    [taskId, userIds, actorId],
  );
}

async function applyLabels(
  client: PoolClient,
  orgId: string,
  taskId: string,
  labels: string[],
): Promise<void> {
  const names = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
  await client.query('DELETE FROM task_labels WHERE task_id = $1', [taskId]);
  if (names.length === 0) return;

  await client.query(
    `INSERT INTO labels (org_id, name) SELECT $1, unnest($2::text[]) ON CONFLICT (org_id, name) DO NOTHING`,
    [orgId, names],
  );
  await client.query(
    `
    INSERT INTO task_labels (task_id, label_id)
    SELECT $1, l.id FROM labels l WHERE l.org_id = $2 AND l.name = ANY($3::citext[])
    ON CONFLICT DO NOTHING
    `,
    [taskId, orgId, names],
  );
}

async function notifyAssignment(
  actor: AuthenticatedActor,
  task: Task,
  assigneeIds: string[],
): Promise<void> {
  await notify({
    orgId: actor.orgId,
    userIds: assigneeIds,
    kind: 'task_assigned',
    title: `${task.key} was assigned to you`,
    body: task.title,
    link: `/tasks/${task.key}`,
    entityType: 'task',
    entityId: task.id,
    actorId: actor.id,
  });
  for (const userId of assigneeIds) {
    publishToUsers([userId], { type: 'capacity.changed', userId, weekKey: isoWeekKey(new Date()) });
  }
}

export async function deleteTask(actor: AuthenticatedActor, taskIdOrKey: string): Promise<void> {
  const scope = await loadTaskScope(actor, taskIdOrKey);
  if (!scope.isTeamManager && scope.createdBy !== actor.id) {
    throw ApiError.forbidden('Only the team manager or the task creator can delete a task');
  }
  await withTransaction(async (client) => {
    await client.query('DELETE FROM tasks WHERE id = $1', [scope.taskId]);
    await recordAudit(
      {
        orgId: actor.orgId,
        actorId: actor.id,
        action: 'task.deleted',
        entityType: 'task',
        entityId: scope.taskId,
      },
      client,
    );
  });
  publishToTeam(scope.teamId, { type: 'task.deleted', taskId: scope.taskId, teamId: scope.teamId }, actor.id);
}

export async function addComment(
  actor: AuthenticatedActor,
  taskIdOrKey: string,
  body: string,
): Promise<TaskComment> {
  const scope = await assertCanReadTask(actor, taskIdOrKey);
  const row = await queryOne<{ id: string; created_at: Date }>(
    `INSERT INTO task_comments (task_id, author_id, body) VALUES ($1, $2, $3) RETURNING id, created_at`,
    [scope.taskId, actor.id, body],
  );
  if (!row) throw ApiError.internal('Could not add the comment');

  // Everyone attached to the task hears about a new comment.
  const watchers = await queryRows<{ user_id: string }>(
    `
    SELECT ta.user_id FROM task_assignees ta WHERE ta.task_id = $1
    UNION
    SELECT t.created_by FROM tasks t WHERE t.id = $1 AND t.created_by IS NOT NULL
    `,
    [scope.taskId],
  );
  const task = await queryOne<{ key: string; title: string }>('SELECT key, title FROM tasks WHERE id = $1', [
    scope.taskId,
  ]);
  await notify({
    orgId: actor.orgId,
    userIds: watchers.map((watcher) => watcher.user_id),
    kind: 'comment',
    title: `${actor.displayName} commented on ${task?.key ?? 'a task'}`,
    body: body.slice(0, 200),
    link: `/tasks/${task?.key ?? scope.taskId}`,
    entityType: 'task',
    entityId: scope.taskId,
    actorId: actor.id,
  });

  return {
    id: row.id,
    taskId: scope.taskId,
    authorId: actor.id,
    authorName: actor.displayName,
    body,
    createdAt: row.created_at.toISOString(),
    updatedAt: null,
  };
}

export async function listComments(actor: AuthenticatedActor, taskIdOrKey: string): Promise<TaskComment[]> {
  const scope = await assertCanReadTask(actor, taskIdOrKey);
  const rows = await queryRows<{
    id: string;
    task_id: string;
    author_id: string | null;
    author_name: string | null;
    body: string;
    created_at: Date;
    updated_at: Date | null;
  }>(
    `
    SELECT tc.id, tc.task_id, tc.author_id, u.display_name AS author_name, tc.body, tc.created_at, tc.updated_at
      FROM task_comments tc
      LEFT JOIN users u ON u.id = tc.author_id
     WHERE tc.task_id = $1
     ORDER BY tc.created_at
    `,
    [scope.taskId],
  );
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    authorId: row.author_id ?? '',
    authorName: row.author_name ?? 'Deactivated user',
    body: row.body,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at?.toISOString() ?? null,
  }));
}

export async function listActivity(
  actor: AuthenticatedActor,
  taskIdOrKey: string,
): Promise<TaskActivityEntry[]> {
  const scope = await assertCanReadTask(actor, taskIdOrKey);
  const rows = await queryRows<{
    id: string;
    task_id: string;
    actor_id: string | null;
    actor_name: string | null;
    action: string;
    field: string | null;
    from_value: string | null;
    to_value: string | null;
    created_at: Date;
  }>(
    `
    SELECT ta.id::text AS id, ta.task_id, ta.actor_id, u.display_name AS actor_name, ta.action,
           ta.field, ta.from_value, ta.to_value, ta.created_at
      FROM task_activity ta
      LEFT JOIN users u ON u.id = ta.actor_id
     WHERE ta.task_id = $1
     ORDER BY ta.created_at DESC
     LIMIT 200
    `,
    [scope.taskId],
  );
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    field: row.field,
    fromValue: row.from_value,
    toValue: row.to_value,
    createdAt: row.created_at.toISOString(),
  }));
}

/**
 * Dependencies must stay acyclic or the blocked-by checks above could
 * deadlock a board. The recursive walk rejects a cycle before insert.
 */
export async function addDependency(
  actor: AuthenticatedActor,
  taskIdOrKey: string,
  dependsOnTaskIdOrKey: string,
  type: DependencyType,
): Promise<void> {
  const scope = await assertCanWriteTask(actor, taskIdOrKey);
  const target = await loadTaskScope(actor, dependsOnTaskIdOrKey);
  if (scope.taskId === target.taskId) throw ApiError.unprocessable('A task cannot depend on itself');

  if (type === 'blocks') {
    const cycle = await queryOne<{ cycle: boolean }>(
      `
      WITH RECURSIVE chain AS (
        SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id = $1 AND type = 'blocks'
        UNION
        SELECT d.depends_on_task_id
          FROM task_dependencies d JOIN chain c ON d.task_id = c.id
         WHERE d.type = 'blocks'
      )
      SELECT EXISTS (SELECT 1 FROM chain WHERE id = $2) AS cycle
      `,
      [target.taskId, scope.taskId],
    );
    if (cycle?.cycle) throw ApiError.conflict('That dependency would create a cycle');
  }

  await query(
    `INSERT INTO task_dependencies (task_id, depends_on_task_id, type) VALUES ($1, $2, $3::dependency_type)
     ON CONFLICT DO NOTHING`,
    [scope.taskId, target.taskId, type],
  );
}

export async function removeDependency(
  actor: AuthenticatedActor,
  taskIdOrKey: string,
  dependencyId: string,
): Promise<void> {
  const scope = await assertCanWriteTask(actor, taskIdOrKey);
  await query('DELETE FROM task_dependencies WHERE id = $1 AND task_id = $2', [dependencyId, scope.taskId]);
}

export async function listDependencies(
  actor: AuthenticatedActor,
  taskIdOrKey: string,
): Promise<{ id: string; type: DependencyType; task: { id: string; key: string; title: string; status: TaskStatus }; direction: 'depends_on' | 'blocks' }[]> {
  const scope = await assertCanReadTask(actor, taskIdOrKey);
  const rows = await queryRows<{
    id: string;
    type: DependencyType;
    other_id: string;
    other_key: string;
    other_title: string;
    other_status: TaskStatus;
    direction: 'depends_on' | 'blocks';
  }>(
    `
    SELECT d.id, d.type, t.id AS other_id, t.key AS other_key, t.title AS other_title, t.status AS other_status,
           'depends_on' AS direction
      FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id
     WHERE d.task_id = $1
    UNION ALL
    SELECT d.id, d.type, t.id, t.key, t.title, t.status, 'blocks' AS direction
      FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
     WHERE d.depends_on_task_id = $1
    `,
    [scope.taskId],
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    direction: row.direction,
    task: { id: row.other_id, key: row.other_key, title: row.other_title, status: row.other_status },
  }));
}

export async function logWork(
  actor: AuthenticatedActor,
  taskIdOrKey: string,
  hours: number,
  loggedOn: string,
  remainingHours?: number,
  note?: string,
): Promise<Task> {
  const scope = await assertCanWriteTask(actor, taskIdOrKey);

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO work_logs (task_id, user_id, hours, logged_on, note) VALUES ($1, $2, $3, $4, $5)`,
      [scope.taskId, actor.id, hours, loggedOn, note ?? null],
    );
    // logged_hours is kept denormalized on the task so the board and reports
    // do not aggregate work_logs on every read.
    await client.query('UPDATE tasks SET logged_hours = logged_hours + $2 WHERE id = $1', [scope.taskId, hours]);
    if (remainingHours !== undefined) {
      await client.query('UPDATE tasks SET remaining_hours = $2 WHERE id = $1', [scope.taskId, remainingHours]);
    } else {
      // Burn down the remaining estimate by what was logged, floored at zero.
      await client.query('UPDATE tasks SET remaining_hours = GREATEST(0, remaining_hours - $2) WHERE id = $1', [
        scope.taskId,
        hours,
      ]);
    }
    await client.query(
      `INSERT INTO task_activity (task_id, actor_id, action, field, to_value) VALUES ($1, $2, 'logged_work', 'loggedHours', $3)`,
      [scope.taskId, actor.id, String(hours)],
    );
  });

  publishToUsers([actor.id], { type: 'capacity.changed', userId: actor.id, weekKey: isoWeekKey(new Date()) });
  return getTask(actor, scope.taskId);
}

/** Kanban columns, ordered the way the board renders them. */
export async function kanbanBoard(
  actor: AuthenticatedActor,
  teamId: string,
): Promise<{ status: TaskStatus; tasks: Task[] }[]> {
  await assertTeamMember(actor, teamId);
  const rows = await queryRows<TaskRow>(
    `
    SELECT ${TASK_SELECT}
      FROM tasks t
     WHERE t.team_id = $1 AND t.parent_task_id IS NULL AND t.status <> 'cancelled'
     ORDER BY t.priority DESC, t.due_date NULLS LAST, t.created_at
    `,
    [teamId],
  );
  const tasks = rows.map(toTask);
  const columns: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done'];
  return columns.map((status) => ({ status, tasks: tasks.filter((task) => task.status === status) }));
}

export async function calendarTasks(
  actor: AuthenticatedActor,
  filter: { teamId?: string; from: string; to: string; assigneeId?: string },
): Promise<Task[]> {
  const conditions = [
    't.org_id = $1',
    't.due_date BETWEEN $2::date AND $3::date',
    `(EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.team_id AND tm.user_id = $4)
      OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $4)
      OR $5 = 'admin')`,
  ];
  const params: unknown[] = [actor.orgId, filter.from, filter.to, actor.id, actor.role];
  if (filter.teamId) {
    params.push(filter.teamId);
    conditions.push(`t.team_id = $${params.length}`);
  }
  if (filter.assigneeId) {
    params.push(filter.assigneeId);
    conditions.push(`EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $${params.length})`);
  }

  const rows = await queryRows<TaskRow>(
    `SELECT ${TASK_SELECT} FROM tasks t WHERE ${conditions.join(' AND ')} ORDER BY t.due_date, t.priority DESC`,
    params,
  );
  return rows.map(toTask);
}

export const openStatuses = OPEN_TASK_STATUSES;
