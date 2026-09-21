import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { TASK_STATUSES, type Task, type TaskActivityEntry, type TaskComment, type TaskStatus } from '@teamspace/shared';
import { api, ApiError } from '../api/client';
import {
  Avatar,
  Badge,
  Button,
  Card,
  DueDate,
  EmptyState,
  ErrorBlock,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  PriorityDot,
  Select,
  Textarea,
  formatHours,
  formatRelativeTime,
} from '../components/ui';
import { useAuth } from '../state/AuthContext';
import { useToast } from '../state/ToastContext';

interface DependencyEntry {
  id: string;
  type: string;
  direction: 'depends_on' | 'blocks';
  task: { id: string; key: string; title: string; status: TaskStatus };
}

export function TaskDetailPage(): JSX.Element {
  const { taskKey = '' } = useParams();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const { user } = useAuth();
  const [comment, setComment] = useState('');
  const [logHours, setLogHours] = useState('');

  const taskQuery = useQuery({
    queryKey: ['tasks', taskKey],
    queryFn: () => api.get<Task>(`/tasks/${taskKey}`),
  });

  const commentsQuery = useQuery({
    queryKey: ['tasks', taskKey, 'comments'],
    queryFn: () => api.get<{ items: TaskComment[] }>(`/tasks/${taskKey}/comments`).then((r) => r.items),
    enabled: Boolean(taskQuery.data),
  });

  const activityQuery = useQuery({
    queryKey: ['tasks', taskKey, 'activity'],
    queryFn: () => api.get<{ items: TaskActivityEntry[] }>(`/tasks/${taskKey}/activity`).then((r) => r.items),
    enabled: Boolean(taskQuery.data),
  });

  const dependenciesQuery = useQuery({
    queryKey: ['tasks', taskKey, 'dependencies'],
    queryFn: () => api.get<{ items: DependencyEntry[] }>(`/tasks/${taskKey}/dependencies`).then((r) => r.items),
    enabled: Boolean(taskQuery.data),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['tasks', taskKey] });
    void queryClient.invalidateQueries({ queryKey: ['board'] });
    void queryClient.invalidateQueries({ queryKey: ['capacity'] });
  };

  const update = useMutation({
    mutationFn: (patch: Partial<Task> & { status?: TaskStatus }) => api.patch<Task>(`/tasks/${taskKey}`, patch),
    onSuccess: () => {
      notify('Task updated', 'success');
      invalidate();
    },
    onError: (error) => notify(error instanceof ApiError ? error.message : 'Update failed', 'error'),
  });

  const addComment = useMutation({
    mutationFn: (body: string) => api.post<TaskComment>(`/tasks/${taskKey}/comments`, { body }),
    onSuccess: () => {
      setComment('');
      void queryClient.invalidateQueries({ queryKey: ['tasks', taskKey, 'comments'] });
    },
    onError: (error) => notify(error instanceof ApiError ? error.message : 'Comment failed', 'error'),
  });

  const logWork = useMutation({
    mutationFn: (hours: number) => api.post<Task>(`/tasks/${taskKey}/work-logs`, { hours }),
    onSuccess: () => {
      setLogHours('');
      notify('Work logged', 'success');
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ['tasks', taskKey, 'activity'] });
    },
    onError: (error) => notify(error instanceof ApiError ? error.message : 'Could not log work', 'error'),
  });

  if (taskQuery.isPending) return <LoadingBlock rows={6} label="Loading the task" />;
  if (taskQuery.error) return <ErrorBlock error={taskQuery.error} onRetry={() => void taskQuery.refetch()} />;

  const task = taskQuery.data;
  const progress =
    task.estimatedHours > 0
      ? Math.min(100, Math.round(((task.estimatedHours - task.remainingHours) / task.estimatedHours) * 100))
      : 0;

  return (
    <>
      <PageHeader
        title={task.title}
        subtitle={`${task.key} · created ${formatRelativeTime(task.createdAt)}`}
        actions={
          <>
            <label className="sr-only" htmlFor="detail-status">
              Status
            </label>
            <Select
              id="detail-status"
              value={task.status}
              onChange={(event) => update.mutate({ status: event.target.value as TaskStatus })}
              style={{ width: 'auto' }}
            >
              {TASK_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </>
        }
      />

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)' }}>
        <div className="stack">
          <Card title="Description">
            {task.description ? (
              <p style={{ whiteSpace: 'pre-wrap' }}>{task.description}</p>
            ) : (
              <p className="muted">No description yet.</p>
            )}
          </Card>

          <Card title="Progress">
            <div className="row" style={{ gap: 'var(--space-4)' }}>
              <div style={{ flex: 1 }}>
                <div className="meter" role="meter" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label={`${progress}% complete`}>
                  <div className="meter__fill meter__fill--healthy" style={{ width: `${progress}%` }} />
                </div>
                <p className="tiny" style={{ marginTop: 'var(--space-1)' }}>
                  {formatHours(task.loggedHours)} logged · {formatHours(task.remainingHours)} remaining of{' '}
                  {formatHours(task.estimatedHours)} estimated
                </p>
              </div>
            </div>

            <div className="row" style={{ marginTop: 'var(--space-4)', gap: 'var(--space-3)', alignItems: 'flex-end' }}>
              <div style={{ width: 140 }}>
                <Field label="Log hours" htmlFor="log-hours">
                  <Input
                    id="log-hours"
                    type="number"
                    min={0.25}
                    max={24}
                    step={0.25}
                    value={logHours}
                    onChange={(event) => setLogHours(event.target.value)}
                  />
                </Field>
              </div>
              <Button
                style={{ marginBottom: 'var(--space-4)' }}
                disabled={!logHours || logWork.isPending}
                onClick={() => logWork.mutate(Number(logHours))}
              >
                Log work
              </Button>
              <div style={{ width: 170 }}>
                <Field label="Remaining effort" htmlFor="remaining-hours" hint="Re-estimate as you learn more.">
                  <Input
                    id="remaining-hours"
                    type="number"
                    min={0}
                    step={0.5}
                    defaultValue={task.remainingHours}
                    onBlur={(event) => {
                      const value = Number(event.target.value);
                      if (value !== task.remainingHours) update.mutate({ remainingHours: value });
                    }}
                  />
                </Field>
              </div>
            </div>
          </Card>

          <Card title={`Comments (${commentsQuery.data?.length ?? 0})`}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (comment.trim()) addComment.mutate(comment.trim());
              }}
              style={{ marginBottom: 'var(--space-4)' }}
            >
              <label className="sr-only" htmlFor="new-comment">
                Add a comment
              </label>
              <Textarea
                id="new-comment"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                rows={2}
                placeholder="Leave a note for the team…"
              />
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 'var(--space-2)' }}>
                <Button type="submit" size="sm" disabled={!comment.trim() || addComment.isPending}>
                  Comment
                </Button>
              </div>
            </form>

            {(commentsQuery.data ?? []).length === 0 ? (
              <EmptyState icon="◎" title="No comments yet" />
            ) : (
              <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {(commentsQuery.data ?? []).map((entry) => (
                  <li key={entry.id} className="row" style={{ alignItems: 'flex-start' }}>
                    <Avatar name={entry.authorName} size="sm" />
                    <div style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 'var(--space-2)' }}>
                        <strong style={{ fontSize: 'var(--text-sm)' }}>{entry.authorName}</strong>
                        <span className="tiny">{formatRelativeTime(entry.createdAt)}</span>
                      </div>
                      <p style={{ whiteSpace: 'pre-wrap' }}>{entry.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title="Details">
            <dl className="stack" style={{ margin: 0 }}>
              <Detail label="Assignees">
                {task.assignees.length === 0 ? (
                  <span className="muted">Unassigned</span>
                ) : (
                  <span className="stack" style={{ gap: 'var(--space-1)' }}>
                    {task.assignees.map((assignee) => (
                      <span className="row" key={assignee.userId}>
                        <Avatar name={assignee.displayName} src={assignee.avatarUrl} size="sm" />
                        {assignee.displayName}
                        {assignee.allocatedHours > 0 && (
                          <span className="tiny numeric">{formatHours(assignee.allocatedHours)}</span>
                        )}
                      </span>
                    ))}
                  </span>
                )}
              </Detail>
              <Detail label="Priority">
                <PriorityDot priority={task.priority} />
              </Detail>
              <Detail label="Due">
                <DueDate date={task.dueDate} done={task.status === 'done'} />
              </Detail>
              <Detail label="Labels">
                {task.labels.length === 0 ? (
                  <span className="muted">None</span>
                ) : (
                  <span className="row row--wrap" style={{ gap: 4 }}>
                    {task.labels.map((label) => (
                      <Badge key={label}>{label}</Badge>
                    ))}
                  </span>
                )}
              </Detail>
              {task.recurrence && (
                <Detail label="Repeats">
                  every {task.recurrence.interval} × {task.recurrence.frequency}
                </Detail>
              )}
              {task.subtaskCount > 0 && (
                <Detail label="Subtasks">
                  {task.completedSubtaskCount} of {task.subtaskCount} done
                </Detail>
              )}
              <Detail label="Created by">{user?.id === task.createdBy ? 'You' : 'Team member'}</Detail>
            </dl>
          </Card>

          <Card title="Dependencies">
            {(dependenciesQuery.data ?? []).length === 0 ? (
              <p className="muted">No linked work.</p>
            ) : (
              <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {(dependenciesQuery.data ?? []).map((dependency) => (
                  <li key={`${dependency.id}-${dependency.direction}`}>
                    <span className="tiny">
                      {dependency.direction === 'depends_on' ? 'Blocked by' : 'Blocks'}
                    </span>
                    <br />
                    <Link to={`/tasks/${dependency.task.key}`}>
                      {dependency.task.key} · {dependency.task.title}
                    </Link>
                    <Badge tone={dependency.task.status === 'done' ? 'healthy' : undefined}>
                      {dependency.task.status.replace('_', ' ')}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Activity">
            {(activityQuery.data ?? []).length === 0 ? (
              <p className="muted">Nothing recorded yet.</p>
            ) : (
              <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 'var(--space-2)' }}>
                {(activityQuery.data ?? []).slice(0, 12).map((entry) => (
                  <li key={entry.id} className="tiny">
                    <strong>{entry.actorName ?? 'Someone'}</strong>{' '}
                    {describeActivity(entry)} · {formatRelativeTime(entry.createdAt)}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <dt className="metric__label">{label}</dt>
      <dd style={{ margin: 0, marginTop: 2 }}>{children}</dd>
    </div>
  );
}

function describeActivity(entry: TaskActivityEntry): string {
  switch (entry.action) {
    case 'created':
      return 'created this task';
    case 'created_from_recurrence':
      return 'created this from a recurring rule';
    case 'status_changed':
      return `moved it from ${entry.fromValue ?? '?'} to ${entry.toValue ?? '?'}`;
    case 'assigned':
      return 'changed the assignees';
    case 'logged_work':
      return `logged ${entry.toValue ?? '?'}h`;
    default:
      return entry.field ? `updated ${entry.field}` : 'updated the task';
  }
}
