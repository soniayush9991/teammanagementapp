import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Task, TaskStatus } from '@teamspace/shared';
import { api, ApiError, qs } from '../api/client';
import {
  AvatarStack,
  Badge,
  Button,
  DueDate,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  PriorityDot,
  formatHours,
} from '../components/ui';
import { TeamPicker, useTeamSelection } from '../components/TeamPicker';
import { NewTaskDialog } from '../components/NewTaskDialog';
import { useToast } from '../state/ToastContext';

const COLUMN_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

interface Column {
  status: TaskStatus;
  tasks: Task[];
}

/**
 * Kanban board with pointer drag-and-drop and a keyboard equivalent: every
 * card exposes a "move to" control, because drag-and-drop alone locks out
 * keyboard and screen-reader users.
 */
export function BoardPage(): JSX.Element {
  const { teamId, setTeamId, teams } = useTeamSelection();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [dragging, setDragging] = useState<Task | null>(null);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [composing, setComposing] = useState(false);

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['board', teamId],
    queryFn: () => api.get<{ columns: Column[] }>(`/tasks/board${qs({ teamId })}`).then((r) => r.columns),
    enabled: Boolean(teamId),
  });

  const move = useMutation({
    mutationFn: ({ task, status }: { task: Task; status: TaskStatus }) =>
      api.patch<Task>(`/tasks/${task.key}`, { status }),
    // Optimistic: the card moves immediately and rolls back if the server
    // refuses the transition.
    onMutate: async ({ task, status }) => {
      await queryClient.cancelQueries({ queryKey: ['board', teamId] });
      const previous = queryClient.getQueryData<Column[]>(['board', teamId]);

      queryClient.setQueryData<Column[]>(['board', teamId], (columns) =>
        columns?.map((column) => {
          if (column.status === task.status) {
            return { ...column, tasks: column.tasks.filter((entry) => entry.id !== task.id) };
          }
          if (column.status === status) {
            return { ...column, tasks: [{ ...task, status }, ...column.tasks] };
          }
          return column;
        }),
      );
      return { previous };
    },
    onError: (mutationError, _variables, context) => {
      queryClient.setQueryData(['board', teamId], context?.previous);
      notify(
        mutationError instanceof ApiError ? mutationError.message : 'That move was not allowed',
        'error',
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['board', teamId] });
      void queryClient.invalidateQueries({ queryKey: ['capacity'] });
    },
  });

  if (!teamId) {
    return (
      <>
        <PageHeader title="Board" />
        <EmptyState icon="▦" title="No team selected" description="You are not a member of any team yet." />
      </>
    );
  }
  if (isPending) return <LoadingBlock rows={4} label="Loading the board" />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  return (
    <>
      <PageHeader
        title="Board"
        subtitle="Drag a card between columns, or use the move control on any card."
        actions={
          <>
            <TeamPicker teams={teams} teamId={teamId} onChange={setTeamId} />
            <Button onClick={() => setComposing(true)}>New task</Button>
          </>
        }
      />

      <div className="board">
        {data.map((column) => (
          <section
            key={column.status}
            className={`board__column${dropTarget === column.status ? ' board__column--drop' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDropTarget(column.status);
            }}
            onDragLeave={() => setDropTarget((current) => (current === column.status ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              setDropTarget(null);
              if (dragging && dragging.status !== column.status) {
                move.mutate({ task: dragging, status: column.status });
              }
              setDragging(null);
            }}
            aria-label={`${COLUMN_LABELS[column.status]}, ${column.tasks.length} tasks`}
          >
            <header className="board__column-header">
              {COLUMN_LABELS[column.status]}
              <span className="board__count">{column.tasks.length}</span>
            </header>

            <div className="board__list">
              {column.tasks.length === 0 && <p className="tiny" style={{ padding: 'var(--space-2)' }}>Nothing here</p>}
              {column.tasks.map((task) => (
                <article
                  key={task.id}
                  className={`task-card${dragging?.id === task.id ? ' task-card--dragging' : ''}`}
                  draggable
                  onDragStart={() => setDragging(task)}
                  onDragEnd={() => {
                    setDragging(null);
                    setDropTarget(null);
                  }}
                >
                  <div className="row row--between">
                    <span className="task-card__key">{task.key}</span>
                    <PriorityDot priority={task.priority} />
                  </div>

                  <Link to={`/tasks/${task.key}`} className="task-card__title" style={{ color: 'inherit', display: 'block' }}>
                    {task.title}
                  </Link>

                  <div className="task-card__meta">
                    {task.labels.slice(0, 2).map((label) => (
                      <Badge key={label}>{label}</Badge>
                    ))}
                    <span className="spacer" />
                    <span className="tiny numeric">{formatHours(task.remainingHours)}</span>
                    <AvatarStack people={task.assignees} max={2} />
                  </div>

                  <div className="row row--between" style={{ marginTop: 'var(--space-2)' }}>
                    <DueDate date={task.dueDate} done={task.status === 'done'} />
                    {/* Keyboard-accessible alternative to dragging. */}
                    <label className="sr-only" htmlFor={`move-${task.id}`}>
                      Move {task.key} to another column
                    </label>
                    <select
                      id={`move-${task.id}`}
                      className="select"
                      style={{ width: 'auto', fontSize: 'var(--text-xs)', padding: '2px 4px' }}
                      value={task.status}
                      onChange={(event) =>
                        move.mutate({ task, status: event.target.value as TaskStatus })
                      }
                    >
                      {data.map((option) => (
                        <option key={option.status} value={option.status}>
                          {COLUMN_LABELS[option.status]}
                        </option>
                      ))}
                    </select>
                  </div>

                  {task.subtaskCount > 0 && (
                    <p className="tiny" style={{ marginTop: 'var(--space-1)' }}>
                      {task.completedSubtaskCount}/{task.subtaskCount} subtasks
                    </p>
                  )}
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>

      {composing && teamId && (
        <NewTaskDialog teamId={teamId} onClose={() => setComposing(false)} />
      )}
    </>
  );
}
