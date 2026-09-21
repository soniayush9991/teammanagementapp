import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Notification } from '@teamspace/shared';
import { api } from '../api/client';
import { Button, EmptyState, formatRelativeTime } from './ui';

export function NotificationBell(): JSX.Element {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: Notification[]; unreadCount: number }>('/notifications?limit=12'),
    // Realtime pushes new notifications; this is a safety net for a dropped
    // socket rather than the primary path.
    refetchInterval: 120_000,
  });

  const markAllRead = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.post('/notifications/read', { notificationIds: [id] }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const unread = data?.unreadCount ?? 0;
  const items = data?.items ?? [];

  return (
    <div style={{ position: 'relative' }} ref={containerRef}>
      <Button
        variant="ghost"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      >
        <span aria-hidden="true">◔</span>
        {unread > 0 && <span className="nav-link__badge">{unread > 99 ? '99+' : unread}</span>}
      </Button>

      {open && (
        <div
          className="search-results"
          style={{ left: 'auto', right: 0, width: 340 }}
          role="region"
          aria-label="Notifications"
        >
          <div className="card__header">
            <strong style={{ fontSize: 'var(--text-sm)' }}>Notifications</strong>
            {unread > 0 && (
              <Button variant="ghost" size="sm" onClick={() => markAllRead.mutate()}>
                Mark all read
              </Button>
            )}
          </div>

          {items.length === 0 ? (
            <EmptyState icon="◔" title="Nothing new" description="Mentions and assignments will appear here." />
          ) : (
            items.map((notification) => (
              <Link
                key={notification.id}
                to={notification.link ?? '#'}
                className="search-result"
                onClick={() => {
                  if (!notification.readAt) markRead.mutate(notification.id);
                  setOpen(false);
                }}
                style={{ background: notification.readAt ? undefined : 'var(--accent-subtle)' }}
              >
                <div className="row row--between">
                  <strong className="truncate" style={{ fontSize: 'var(--text-sm)' }}>
                    {notification.title}
                  </strong>
                  <span className="tiny">{formatRelativeTime(notification.createdAt)}</span>
                </div>
                {notification.body && <p className="tiny truncate">{notification.body}</p>}
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  );
}
