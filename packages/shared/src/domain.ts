/**
 * Core domain vocabulary shared by the API and the web client.
 * Keeping these unions in one place means a status added here is a compile
 * error everywhere it has to be handled.
 */

export const ROLES = ['admin', 'manager', 'member'] as const;
export type Role = (typeof ROLES)[number];

export const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses that still consume capacity. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'];

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const DEPENDENCY_TYPES = ['blocks', 'relates_to', 'duplicates'] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'biweekly', 'monthly'] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export const CONVERSATION_KINDS = ['dm', 'group', 'channel'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const CONVERSATION_VISIBILITIES = ['public', 'private'] as const;
export type ConversationVisibility = (typeof CONVERSATION_VISIBILITIES)[number];

export const LEAVE_KINDS = ['vacation', 'sick', 'holiday', 'other'] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const NOTIFICATION_KINDS = [
  'task_assigned',
  'task_status_changed',
  'task_due_soon',
  'task_overdue',
  'mention',
  'group_invitation',
  'message',
  'comment',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const UTILIZATION_BANDS = ['healthy', 'near_capacity', 'overloaded', 'underutilized'] as const;
export type UtilizationBand = (typeof UTILIZATION_BANDS)[number];
