import type { Task, TaskPriority, TaskStatus, RecurrenceFrequency } from '@teamspace/shared';

/**
 * Canonical task projection. Counts are computed as correlated subqueries
 * rather than joins so a task with 40 comments does not multiply rows.
 */
export const TASK_SELECT = `
  t.id, t.team_id, t.key, t.parent_task_id, t.title, t.description, t.status, t.priority,
  t.created_by, t.start_date, t.due_date, t.estimated_hours, t.remaining_hours, t.logged_hours,
  t.recurrence_freq, t.recurrence_interval, t.recurrence_until, t.recurrence_next_at,
  t.created_at, t.updated_at, t.completed_at,
  COALESCE((SELECT array_agg(l.name::text ORDER BY l.name)
              FROM task_labels tl JOIN labels l ON l.id = tl.label_id
             WHERE tl.task_id = t.id), '{}') AS labels,
  COALESCE((SELECT json_agg(json_build_object(
                      'userId', ta.user_id,
                      'displayName', au.display_name,
                      'avatarUrl', au.avatar_url,
                      'allocatedHours', ta.allocated_hours)
                    ORDER BY au.display_name)
              FROM task_assignees ta JOIN users au ON au.id = ta.user_id
             WHERE ta.task_id = t.id), '[]') AS assignees,
  (SELECT count(*) FROM tasks st WHERE st.parent_task_id = t.id) AS subtask_count,
  (SELECT count(*) FROM tasks st WHERE st.parent_task_id = t.id AND st.status = 'done') AS completed_subtask_count,
  (SELECT count(*) FROM task_comments tc WHERE tc.task_id = t.id) AS comment_count,
  (SELECT count(*) FROM attachments a WHERE a.task_id = t.id) AS attachment_count
`;

export interface TaskRow {
  id: string;
  team_id: string;
  key: string;
  parent_task_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  created_by: string | null;
  start_date: Date | null;
  due_date: Date | null;
  estimated_hours: string;
  remaining_hours: string;
  logged_hours: string;
  recurrence_freq: RecurrenceFrequency | null;
  recurrence_interval: number | null;
  recurrence_until: Date | null;
  recurrence_next_at: Date | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  labels: string[];
  assignees: { userId: string; displayName: string; avatarUrl: string | null; allocatedHours: string | number }[];
  subtask_count: string;
  completed_subtask_count: string;
  comment_count: string;
  attachment_count: string;
}

function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    key: row.key,
    teamId: row.team_id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    createdBy: row.created_by ?? '',
    assignees: (row.assignees ?? []).map((assignee) => ({
      userId: assignee.userId,
      displayName: assignee.displayName,
      avatarUrl: assignee.avatarUrl,
      allocatedHours: Number(assignee.allocatedHours),
    })),
    dueDate: dateOnly(row.due_date),
    startDate: dateOnly(row.start_date),
    estimatedHours: Number(row.estimated_hours),
    remainingHours: Number(row.remaining_hours),
    loggedHours: Number(row.logged_hours),
    labels: row.labels ?? [],
    subtaskCount: Number(row.subtask_count),
    completedSubtaskCount: Number(row.completed_subtask_count),
    commentCount: Number(row.comment_count),
    attachmentCount: Number(row.attachment_count),
    recurrence: row.recurrence_freq
      ? {
          frequency: row.recurrence_freq,
          interval: row.recurrence_interval ?? 1,
          until: dateOnly(row.recurrence_until),
          nextRunAt: row.recurrence_next_at?.toISOString() ?? null,
        }
      : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}
