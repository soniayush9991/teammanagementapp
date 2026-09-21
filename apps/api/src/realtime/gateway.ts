import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { queryRows, query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { eventBus } from './bus.js';
import type { ClientEvent, OutboundEvent, ServerEvent } from './events.js';

interface Connection {
  socket: WebSocket;
  userId: string;
  orgId: string;
  /** Conversations this socket has subscribed to, so we do not push every
   *  conversation the user belongs to down every tab. */
  conversationIds: Set<string>;
  teamIds: Set<string>;
  isAlive: boolean;
}

const MAX_FRAME_BYTES = 16 * 1024;

export class RealtimeGateway {
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<WebSocket, Connection>();
  /** userId -> sockets, so a user with three tabs gets three deliveries. */
  private readonly byUser = new Map<string, Set<WebSocket>>();
  private heartbeat: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    server.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith('/ws')) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws, req).catch((error) => {
          logger.warn({ err: error }, 'websocket handshake rejected');
          ws.close(4001, 'unauthorized');
        });
      });
    });

    this.unsubscribe = eventBus.subscribe((outbound) => this.dispatch(outbound));
    this.startHeartbeat();
  }

  /**
   * Browsers cannot set headers on a WebSocket, so the access token arrives
   * as a query parameter. It is short lived and the connection is closed as
   * soon as it cannot be verified.
   */
  private async onConnection(socket: WebSocket, req: IncomingMessage): Promise<void> {
    const url = new URL(req.url ?? '/ws', 'http://localhost');
    const token = url.searchParams.get('token');
    if (!token) throw new Error('missing token');

    const claims = verifyAccessToken(token);
    const teams = await queryRows<{ team_id: string }>('SELECT team_id FROM team_members WHERE user_id = $1', [
      claims.sub,
    ]);

    const connection: Connection = {
      socket,
      userId: claims.sub,
      orgId: claims.orgId,
      conversationIds: new Set(),
      teamIds: new Set(teams.map((row) => row.team_id)),
      isAlive: true,
    };

    this.connections.set(socket, connection);
    const sockets = this.byUser.get(claims.sub) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.byUser.set(claims.sub, sockets);

    socket.on('pong', () => {
      connection.isAlive = true;
    });
    socket.on('message', (raw) => {
      void this.onMessage(connection, raw.toString());
    });
    socket.on('close', () => this.onClose(connection));
    socket.on('error', (error) => logger.debug({ err: error }, 'websocket error'));

    // First connection for this user means they just came online.
    if (sockets.size === 1) {
      await query('UPDATE users SET last_seen_at = now() WHERE id = $1', [claims.sub]).catch(() => undefined);
      this.broadcastPresence(connection, 'online');
    }
  }

  private async onMessage(connection: Connection, raw: string): Promise<void> {
    let event: ClientEvent;
    try {
      event = JSON.parse(raw) as ClientEvent;
    } catch {
      this.send(connection.socket, { type: 'error', code: 'bad_frame', message: 'Frame was not valid JSON' });
      return;
    }

    switch (event.type) {
      case 'subscribe': {
        // Only conversations the user is actually a member of, checked
        // server side — a client cannot subscribe its way into a private group.
        const allowed = await queryRows<{ conversation_id: string }>(
          `
          SELECT cm.conversation_id
            FROM conversation_members cm
           WHERE cm.user_id = $1 AND cm.conversation_id = ANY($2::uuid[])
          UNION
          SELECT c.id
            FROM conversations c
           WHERE c.org_id = $3 AND c.visibility = 'public' AND c.id = ANY($2::uuid[])
          `,
          [connection.userId, event.conversationIds.slice(0, 200), connection.orgId],
        );
        for (const row of allowed) connection.conversationIds.add(row.conversation_id);
        break;
      }
      case 'unsubscribe': {
        for (const id of event.conversationIds) connection.conversationIds.delete(id);
        break;
      }
      case 'typing': {
        if (!connection.conversationIds.has(event.conversationId)) return;
        const displayName = await this.displayNameOf(connection.userId);
        eventBus.publish({
          target: { kind: 'conversation', conversationId: event.conversationId },
          event: {
            type: 'typing',
            conversationId: event.conversationId,
            userId: connection.userId,
            displayName,
            isTyping: event.isTyping,
          },
          exceptUserId: connection.userId,
        });
        break;
      }
      case 'read': {
        if (!connection.conversationIds.has(event.conversationId)) return;
        await query(
          `UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`,
          [event.conversationId, connection.userId],
        );
        eventBus.publish({
          target: { kind: 'conversation', conversationId: event.conversationId },
          event: {
            type: 'message.read',
            conversationId: event.conversationId,
            userId: connection.userId,
            readAt: new Date().toISOString(),
          },
        });
        break;
      }
      case 'ping':
        this.send(connection.socket, { type: 'presence', userId: connection.userId, status: 'online', at: new Date().toISOString() });
        break;
      default:
        this.send(connection.socket, { type: 'error', code: 'unknown_frame', message: 'Unsupported frame type' });
    }
  }

  private async displayNameOf(userId: string): Promise<string> {
    const rows = await queryRows<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [userId]);
    return rows[0]?.display_name ?? 'Someone';
  }

  private onClose(connection: Connection): void {
    this.connections.delete(connection.socket);
    const sockets = this.byUser.get(connection.userId);
    sockets?.delete(connection.socket);
    if (sockets && sockets.size === 0) {
      this.byUser.delete(connection.userId);
      this.broadcastPresence(connection, 'offline');
    }
  }

  private broadcastPresence(connection: Connection, status: 'online' | 'offline'): void {
    eventBus.publish({
      target: { kind: 'users', userIds: [] },
      event: { type: 'presence', userId: connection.userId, status, at: new Date().toISOString() },
    });
  }

  /** Routes one published event to every socket that should receive it. */
  private dispatch(outbound: OutboundEvent): void {
    const { target, event, exceptUserId } = outbound;

    if (target.kind === 'users') {
      // An empty user list means "everyone connected" (presence fan-out).
      const recipients =
        target.userIds.length > 0
          ? target.userIds.flatMap((userId) => [...(this.byUser.get(userId) ?? [])])
          : [...this.connections.keys()];
      for (const socket of recipients) {
        const connection = this.connections.get(socket);
        if (!connection || connection.userId === exceptUserId) continue;
        this.send(socket, event);
      }
      return;
    }

    for (const connection of this.connections.values()) {
      if (connection.userId === exceptUserId) continue;
      const matches =
        target.kind === 'conversation'
          ? connection.conversationIds.has(target.conversationId)
          : connection.teamIds.has(target.teamId);
      if (matches) this.send(connection.socket, event);
    }
  }

  private send(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(event), (error) => {
      if (error) logger.debug({ err: error }, 'failed to deliver realtime frame');
    });
  }

  /** Drops connections that stopped answering pings (dead NAT, sleeping tab). */
  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      for (const connection of this.connections.values()) {
        if (!connection.isAlive) {
          connection.socket.terminate();
          continue;
        }
        connection.isAlive = false;
        connection.socket.ping();
      }
    }, 30_000);
    this.heartbeat.unref();
  }

  connectionCount(): number {
    return this.connections.size;
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.unsubscribe?.();
    for (const connection of this.connections.values()) connection.socket.close(1001, 'server shutting down');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
