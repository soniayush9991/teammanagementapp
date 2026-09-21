import type {
  ConversationKind,
  ConversationVisibility,
  DependencyType,
  LeaveKind,
  LeaveStatus,
  NotificationKind,
  RecurrenceFrequency,
  Role,
  TaskPriority,
  TaskStatus,
} from './domain.js';
import type { CapacitySnapshot, TeamCapacityRollup } from './capacity.js';
import type { Permission } from './permissions.js';

export interface Paginated<T> {
  items: T[];
  /** Opaque cursor for the next page; null when the list is exhausted. */
  nextCursor: string | null;
  total?: number;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: Role;
  jobTitle: string | null;
  timezone: string;
  skills: string[];
  weeklyCapacityHours: number;
  managerId: string | null;
  isActive: boolean;
}

export interface AuthSession {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: PublicUser;
  permissions: Permission[];
}

export interface Team {
  id: string;
  name: string;
  description: string | null;
  managerId: string;
  memberCount: number;
  createdAt: string;
}

export interface TaskAssignee {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  allocatedHours: number;
}

export interface Task {
  id: string;
  key: string;
  teamId: string;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  createdBy: string;
  assignees: TaskAssignee[];
  dueDate: string | null;
  startDate: string | null;
  estimatedHours: number;
  remainingHours: number;
  loggedHours: number;
  labels: string[];
  subtaskCount: number;
  completedSubtaskCount: number;
  commentCount: number;
  attachmentCount: number;
  recurrence: TaskRecurrence | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TaskRecurrence {
  frequency: RecurrenceFrequency;
  interval: number;
  until: string | null;
  nextRunAt: string | null;
}

export interface TaskDependency {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  type: DependencyType;
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string | null;
}

export interface TaskActivityEntry {
  id: string;
  taskId: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  field: string | null;
  fromValue: string | null;
  toValue: string | null;
  createdAt: string;
}

export interface MemberCapacity {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  jobTitle: string | null;
  skills: string[];
  weekKey: string;
  capacity: CapacitySnapshot;
  openTaskCount: number;
  overdueTaskCount: number;
}

export interface TeamCapacityView {
  teamId: string;
  weekKey: string;
  members: MemberCapacity[];
  rollup: TeamCapacityRollup;
}

export interface LeaveEntry {
  id: string;
  userId: string;
  kind: LeaveKind;
  status: LeaveStatus;
  startDate: string;
  endDate: string;
  hoursPerDay: number;
  note: string | null;
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  visibility: ConversationVisibility;
  name: string | null;
  topic: string | null;
  teamId: string | null;
  memberCount: number;
  createdBy: string;
  lastMessageAt: string | null;
  unreadCount: number;
  /** Present for DMs so the client can render the other person. */
  counterpart?: PublicUser | null;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  userIds: string[];
}

export interface MessageAttachment {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  /** Short-lived presigned download URL. */
  url: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  parentMessageId: string | null;
  authorId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  body: string;
  mentions: string[];
  reactions: MessageReaction[];
  attachments: MessageAttachment[];
  replyCount: number;
  isPinned: boolean;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  /** Users who have read up to or past this message. */
  readBy: string[];
}

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  /** Deep link into the app, e.g. /tasks/TS-214. */
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface SearchHit {
  type: 'task' | 'message' | 'attachment';
  id: string;
  title: string;
  snippet: string;
  link: string;
  rank: number;
  createdAt: string;
  contextLabel: string | null;
}

export interface ManagerDashboard {
  teamId: string;
  weekKey: string;
  capacity: TeamCapacityView;
  activeAssignmentCount: number;
  overdueTaskCount: number;
  dueThisWeekCount: number;
  upcomingDeadlines: Task[];
  workDistribution: { userId: string; displayName: string; plannedHours: number; taskCount: number }[];
  statusBreakdown: { status: TaskStatus; count: number }[];
}

export interface MemberDashboard {
  userId: string;
  weekKey: string;
  capacity: CapacitySnapshot;
  todayTasks: Task[];
  weekTasks: Task[];
  overdueTasks: Task[];
  recentConversations: Conversation[];
  unreadNotificationCount: number;
  pendingMentions: Notification[];
}
