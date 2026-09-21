import type { Message, Notification, Task } from '@teamspace/shared';

/**
 * Every server -> client frame. The client narrows on `type`, so adding a
 * variant here forces the UI to handle it.
 */
export type ServerEvent =
  | { type: 'task.created'; task: Task }
  | { type: 'task.updated'; task: Task; changedFields: string[] }
  | { type: 'task.deleted'; taskId: string; teamId: string }
  | { type: 'task.assigned'; task: Task; assigneeIds: string[]; unassignedIds: string[] }
  | { type: 'capacity.changed'; userId: string; weekKey: string }
  | { type: 'message.created'; message: Message }
  | { type: 'message.updated'; message: Message }
  | { type: 'message.deleted'; conversationId: string; messageId: string }
  | { type: 'message.reaction'; conversationId: string; messageId: string; emoji: string; userId: string; added: boolean }
  | { type: 'message.read'; conversationId: string; userId: string; readAt: string }
  | { type: 'typing'; conversationId: string; userId: string; displayName: string; isTyping: boolean }
  | { type: 'presence'; userId: string; status: 'online' | 'offline'; at: string }
  | { type: 'notification.created'; notification: Notification }
  | { type: 'conversation.updated'; conversationId: string }
  | { type: 'error'; code: string; message: string };

/** Every client -> server frame. */
export type ClientEvent =
  | { type: 'subscribe'; conversationIds: string[] }
  | { type: 'unsubscribe'; conversationIds: string[] }
  | { type: 'typing'; conversationId: string; isTyping: boolean }
  | { type: 'read'; conversationId: string; messageId?: string }
  | { type: 'ping' };

/**
 * Delivery targets. Fan-out is resolved at publish time rather than by the
 * socket layer guessing who should see a change.
 */
export type EventTarget =
  | { kind: 'users'; userIds: string[] }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'team'; teamId: string };

export interface OutboundEvent {
  target: EventTarget;
  event: ServerEvent;
  /** Never echo an action back to the person who caused it. */
  exceptUserId?: string;
}
