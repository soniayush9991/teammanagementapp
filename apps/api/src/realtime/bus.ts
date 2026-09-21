import { EventEmitter } from 'node:events';
import type { OutboundEvent } from './events.js';

/**
 * Decouples services from the socket layer: a service publishes what
 * happened and the gateway decides which sockets receive it.
 *
 * This implementation is in-process, which is correct for a single API
 * instance. Horizontally scaled, replace `publish`/`subscribe` with a Redis
 * pub/sub channel (see docs/12-realtime-messaging-design.md) — the call sites
 * do not change.
 */
class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // A dropped realtime frame must never crash the API process.
    this.emitter.setMaxListeners(50);
  }

  publish(outbound: OutboundEvent): void {
    this.emitter.emit('event', outbound);
  }

  subscribe(listener: (outbound: OutboundEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}

export const eventBus = new EventBus();

export function publishToUsers(
  userIds: string[],
  event: OutboundEvent['event'],
  exceptUserId?: string,
): void {
  if (userIds.length === 0) return;
  eventBus.publish({ target: { kind: 'users', userIds }, event, exceptUserId });
}

export function publishToConversation(
  conversationId: string,
  event: OutboundEvent['event'],
  exceptUserId?: string,
): void {
  eventBus.publish({ target: { kind: 'conversation', conversationId }, event, exceptUserId });
}

export function publishToTeam(teamId: string, event: OutboundEvent['event'], exceptUserId?: string): void {
  eventBus.publish({ target: { kind: 'team', teamId }, event, exceptUserId });
}
