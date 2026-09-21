import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { TASK_PRIORITIES, TASK_STATUSES, type Task } from '@teamspace/shared';
import { api, qs } from '../api/client';
import {
  AvatarStack,
  Badge,
  Button,
  Card,
  DueDate,
  EmptyState,
  ErrorBlock,
  Input,
  LoadingBlock,
  PageHeader,
  PriorityDot,
  Select,
  formatHours,
} from '../components/ui';
import { useDebounced } from '../hooks/useDebounced';

/** Filterable list view with cursor pagination. */
export function TaskListPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const [cursors, setCursors] = useState<string[]>([]);
  const [search, setSearch] = useState(params.get('search') ?? '');
  const debouncedSearch = useDebounced(search, 300);

  const status = params.get('status') ?? '';
  const priority = params.get('priority') ?? '';
  const overdueOnly = params.get('overdueOnly') === 'true';
  const cursor = cursors.at(-1);

  const setParam = (key: string, value: string): void => {
    setCursors([]);
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  };

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['tasks', { status, priority, overdueOnly, debouncedSearch, cursor }],
    queryFn: () =>
      api.get<{ items: Task[]; nextCursor: string | null }>(
        `/tasks${qs({
          status: status || undefined,
          priority: priority || undefined,
          overdueOnly: overdueOnly || undefined,
          search: debouncedSearch.length >= 2 ? debouncedSearch : undefined,
          cursor,
          limit: 25,
        })}`,
      ),
  });

  return (
    <>
      <PageHeader title="All tasks" subtitle="Everything you can see across your teams." />

      <Card flush>
        <div className="card__header" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
          <div style={{ minWidth: 200, flex: 1 }}>
            <label className="sr-only" htmlFor="task-search">
              Search tasks
            </label>
            <Input
              id="task-search"
              type="search"
              placeholder="Search titles and descriptions…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setCursors([]);
              }}
            />
          </div>

          <label className="sr-only" htmlFor="filter-status">
            Status
          </label>
          <Select
            id="filter-status"
            value={status}
            onChange={(event) => setParam('status', event.target.value)}
            style={{ width: 'auto' }}
          >
            <option value="">Any status</option>
            {TASK_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.replace('_', ' ')}
              </option>
            ))}
          </Select>

          <label className="sr-only" htmlFor="filter-priority">
            Priority
          </label>
          <Select
            id="filter-priority"
            value={priority}
            onChange={(event) => setParam('priority', event.target.value)}
            style={{ width: 'auto' }}
          >
            <option value="">Any priority</option>
            {TASK_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>

          <label className="row" style={{ gap: 'var(--space-2)' }}>
            <input
              type="checkbox"
              checked={overdueOnly}
              onChange={(event) => setParam('overdueOnly', event.target.checked ? 'true' : '')}
            />
            Overdue only
          </label>
        </div>

        {isPending ? (
          <div className="card__body">
            <LoadingBlock rows={5} label="Loading tasks" />
          </div>
        ) : error ? (
          <div className="card__body">
            <ErrorBlock error={error} onRetry={() => void refetch()} />
          </div>
        ) : data.items.length === 0 ? (
          <EmptyState icon="☰" title="No tasks match these filters" description="Try widening the search." />
        ) : (
          <table className="table">
            <caption className="sr-only">Tasks matching the selected filters</caption>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Title</th>
                <th scope="col">Status</th>
                <th scope="col">Priority</th>
                <th scope="col">Assignees</th>
                <th scope="col" className="th--numeric">Remaining</th>
                <th scope="col">Due</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((task) => (
                <tr key={task.id}>
                  <td>
                    <Link to={`/tasks/${task.key}`} style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
                      {task.key}
                    </Link>
                  </td>
                  <td>
                    <Link to={`/tasks/${task.key}`} style={{ color: 'inherit' }}>
                      {task.title}
                    </Link>
                    {task.labels.length > 0 && (
                      <span className="row" style={{ gap: 4, marginTop: 4 }}>
                        {task.labels.slice(0, 3).map((label) => (
                          <Badge key={label}>{label}</Badge>
                        ))}
                      </span>
                    )}
                  </td>
                  <td>
                    <Badge tone={task.status === 'done' ? 'healthy' : undefined}>{task.status.replace('_', ' ')}</Badge>
                  </td>
                  <td>
                    <PriorityDot priority={task.priority} />
                  </td>
                  <td>
                    {task.assignees.length === 0 ? (
                      <span className="tiny">Unassigned</span>
                    ) : (
                      <AvatarStack people={task.assignees} />
                    )}
                  </td>
                  <td className="td--numeric numeric">{formatHours(task.remainingHours)}</td>
                  <td>
                    <DueDate date={task.dueDate} done={task.status === 'done'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="card__header" style={{ borderBottom: 'none', justifyContent: 'flex-end' }}>
          <Button
            variant="secondary"
            size="sm"
            disabled={cursors.length === 0}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!data?.nextCursor}
            onClick={() => data?.nextCursor && setCursors((current) => [...current, data.nextCursor!])}
          >
            Next
          </Button>
        </div>
      </Card>
    </>
  );
}
