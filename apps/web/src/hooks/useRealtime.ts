import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getAccessToken } from '../api/client';
import { useAuth } from '../state/AuthContext';

/** Mirrors the server's ServerEvent union. */
export type ServerEvent =
  | { type: 'task.created'; task: { id: string; teamId: string } }
  | { type: 'task.updated'; task: { id: string; teamId: string }; changedFields: string[] }
  | { type: 'task.deleted'; taskId: string; teamId: string }
  | { type: 'task.assigned'; task: { id: string; teamId: string }; assigneeIds: string[]; unassignedIds: string[] }
  | { type: 'capacity.changed'; userId: string; weekKey: string }
  | { type: 'message.created'; message: { id: string; conversationId: string } }
  | { type: 'message.updated'; message: { id: string; conversationId: string } }
  | { type: 'message.deleted'; conversationId: string; messageId: string }
  | { type: 'message.reaction'; conversationId: string; messageId: string; emoji: string; userId: string; added: boolean }
  | { type: 'message.read'; conversationId: string; userId: string; readAt: string }
  | { type: 'typing'; conversationId: string; userId: string; displayName: string; isTyping: boolean }
  | { type: 'presence'; userId: string; status: 'online' | 'offline'; at: string }
  | { type: 'notification.created'; notification: { id: string; title: string } }
  | { type: 'conversation.updated'; conversationId: string }
  | { type: 'error'; code: string; message: string };

type Listener = (event: ServerEvent) => void;

interface RealtimeHandle {
  status: 'connecting' | 'open' | 'closed';
  send: (frame: unknown) => void;
  subscribe: (listener: Listener) => () => void;
  subscribeToConversations: (conversationIds: string[]) => void;
}

/**
 * One WebSocket per tab, shared by every component through this hook.
 *
 * Reconnection uses exponential backoff with jitter so a server restart does
 * not bring every client back in the same millisecond. Cache invalidation on
 * incoming events is centralised here: components just read React Query.
 */
export function useRealtime(): RealtimeHandle {
  const { status: authStatus } = useAuth();
  const queryClient = useQueryClient();
  const socketRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef(new Set<Listener>());
  const subscribedRef = useRef(new Set<string>());
  const attemptRef = useRef(0);
  const closedByUsRef = useRef(false);
  const [status, setStatus] = useState<RealtimeHandle['status']>('closed');

  useEffect(() => {
    if (authStatus !== 'authenticated') return undefined;

    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    closedByUsRef.current = false;

    const connect = (): void => {
      const token = getAccessToken();
      if (!token) return;

      setStatus('connecting');
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        attemptRef.current = 0;
        setStatus('open');
        // Re-subscribe to whatever the UI was watching before the drop.
        if (subscribedRef.current.size > 0) {
          socket.send(JSON.stringify({ type: 'subscribe', conversationIds: [...subscribedRef.current] }));
        }
      });

      socket.addEventListener('message', (event) => {
        let parsed: ServerEvent;
        try {
          parsed = JSON.parse(String(event.data)) as ServerEvent;
        } catch {
          return;
        }
        applyToCache(parsed, queryClient);
        for (const listener of listenersRef.current) listener(parsed);
      });

      socket.addEventListener('close', () => {
        setStatus('closed');
        if (closedByUsRef.current) return;
        const attempt = (attemptRef.current += 1);
        const backoff = Math.min(30_000, 2 ** attempt * 500);
        const jitter = Math.random() * 400;
        reconnectTimer = setTimeout(connect, backoff + jitter);
      });

      socket.addEventListener('error', () => socket.close());
    };

    connect();

    return () => {
      closedByUsRef.current = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [authStatus, queryClient]);

  return useMemo<RealtimeHandle>(
    () => ({
      status,
      send: (frame) => {
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
      },
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
      },
      subscribeToConversations: (conversationIds) => {
        const fresh = conversationIds.filter((id) => !subscribedRef.current.has(id));
        for (const id of conversationIds) subscribedRef.current.add(id);
        const socket = socketRef.current;
        if (fresh.length > 0 && socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'subscribe', conversationIds: fresh }));
        }
      },
    }),
    [status],
  );
}

/**
 * Translates a realtime event into cache invalidation. Keeping this in one
 * function means a new event type has exactly one place to be handled, and
 * screens stay declarative.
 */
function applyToCache(event: ServerEvent, queryClient: ReturnType<typeof useQueryClient>): void {
  switch (event.type) {
    case 'task.created':
    case 'task.updated':
    case 'task.deleted':
    case 'task.assigned':
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['board'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      break;
    case 'capacity.changed':
      void queryClient.invalidateQueries({ queryKey: ['capacity'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      break;
    case 'message.created':
    case 'message.updated':
      void queryClient.invalidateQueries({ queryKey: ['messages', event.message.conversationId] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      break;
    case 'message.deleted':
    case 'message.reaction':
      void queryClient.invalidateQueries({ queryKey: ['messages', event.conversationId] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      break;
    case 'conversation.updated':
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      break;
    case 'notification.created':
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      break;
    default:
      // typing, presence, read receipts and errors are transient: components
      // that care subscribe directly rather than going through the cache.
      break;
  }
}
