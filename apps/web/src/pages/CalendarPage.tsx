import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { addDays, startOfIsoWeek, toDateOnly, type Task } from '@teamspace/shared';
import { api, qs } from '../api/client';
import {
  Badge,
  Button,
  Card,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  PriorityDot,
  formatHours,
} from '../components/ui';

/** A four-week month-style grid of due dates. */
export function CalendarPage(): JSX.Element {
  const [anchor, setAnchor] = useState(() => startOfIsoWeek(new Date()));
  const weeks = 4;

  const from = toDateOnly(anchor);
  const to = toDateOnly(addDays(anchor, weeks * 7 - 1));

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['tasks', 'calendar', from, to],
    queryFn: () => api.get<{ items: Task[] }>(`/tasks/calendar${qs({ from, to })}`).then((r) => r.items),
  });

  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of data ?? []) {
      if (!task.dueDate) continue;
      map.set(task.dueDate, [...(map.get(task.dueDate) ?? []), task]);
    }
    return map;
  }, [data]);

  const today = toDateOnly(new Date());
  const days = Array.from({ length: weeks * 7 }, (_, index) => addDays(anchor, index));

  return (
    <>
      <PageHeader
        title="Calendar"
        subtitle={`Deadlines from ${from} to ${to}`}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => setAnchor((current) => addDays(current, -7))}>
              ← Earlier
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setAnchor(startOfIsoWeek(new Date()))}>
              This week
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setAnchor((current) => addDays(current, 7))}>
              Later →
            </Button>
          </>
        }
      />

      {isPending ? (
        <LoadingBlock rows={6} label="Loading the calendar" />
      ) : error ? (
        <ErrorBlock error={error} onRetry={() => void refetch()} />
      ) : (
        <Card flush>
          <div
            className="grid"
            style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 1, background: 'var(--border-subtle)' }}
          >
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => (
              <div
                key={label}
                style={{ background: 'var(--surface-card)', padding: 'var(--space-2)', textAlign: 'center' }}
                className="metric__label"
              >
                {label}
              </div>
            ))}

            {days.map((day) => {
              const key = toDateOnly(day);
              const tasks = byDay.get(key) ?? [];
              const isToday = key === today;
              const isWeekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;

              return (
                <div
                  key={key}
                  style={{
                    background: isWeekend ? 'var(--surface-sunken)' : 'var(--surface-card)',
                    minHeight: 110,
                    padding: 'var(--space-2)',
                    outline: isToday ? '2px solid var(--accent)' : undefined,
                    outlineOffset: -2,
                  }}
                >
                  <div className="row row--between">
                    <span className={isToday ? 'badge badge--accent' : 'tiny'}>{day.getUTCDate()}</span>
                    {tasks.length > 0 && <span className="tiny">{tasks.length}</span>}
                  </div>

                  <div className="stack" style={{ gap: 2, marginTop: 4 }}>
                    {tasks.slice(0, 3).map((task) => (
                      <Link
                        key={task.id}
                        to={`/tasks/${task.key}`}
                        className="row"
                        style={{ gap: 4, fontSize: 'var(--text-xs)', color: 'inherit' }}
                        title={`${task.key} · ${task.title} · ${formatHours(task.remainingHours)}`}
                      >
                        <PriorityDot priority={task.priority} />
                        <span className="truncate">{task.title}</span>
                      </Link>
                    ))}
                    {tasks.length > 3 && <span className="tiny">+{tasks.length - 3} more</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <p className="tiny" style={{ marginTop: 'var(--space-3)' }}>
        <Badge>Tip</Badge> Only tasks with a due date appear here. Undated work shows on the board and counts
        against the current week's capacity.
      </p>
    </>
  );
}
