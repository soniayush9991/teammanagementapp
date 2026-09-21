import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isoWeekKey, type AssigneeRecommendation, type Task, type TeamCapacityView } from '@teamspace/shared';
import { api, ApiError, qs } from '../api/client';
import {
  Avatar,
  BandBadge,
  Badge,
  Button,
  Card,
  DueDate,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  Select,
  UtilizationMeter,
  formatHours,
  formatPercent,
} from '../components/ui';
import { TeamPicker, useTeamSelection } from '../components/TeamPicker';
import { useToast } from '../state/ToastContext';

/**
 * Capacity planner: every person is a drop zone. Dragging a task onto someone
 * reassigns it, and the projected utilization is shown before the drop so the
 * manager can see the consequence first.
 */
export function PlannerPage(): JSX.Element {
  const { teamId, setTeamId, teams } = useTeamSelection();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [week, setWeek] = useState(() => isoWeekKey(new Date()));
  const [dragging, setDragging] = useState<{ task: Task; fromUserId: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [recommendFor, setRecommendFor] = useState<Task | null>(null);

  const capacityQuery = useQuery({
    queryKey: ['capacity', teamId, week],
    queryFn: () => api.get<TeamCapacityView>(`/capacity/teams/${teamId}${qs({ week })}`),
    enabled: Boolean(teamId),
  });

  const tasksQuery = useQuery({
    queryKey: ['tasks', 'planner', teamId],
    queryFn: () =>
      api
        .get<{ items: Task[] }>(`/tasks${qs({ teamId, status: 'backlog,todo,in_progress,in_review,blocked', limit: 100 })}`)
        .then((response) => response.items),
    enabled: Boolean(teamId),
  });

  const reassign = useMutation({
    mutationFn: ({ task, fromUserId, toUserId }: { task: Task; fromUserId: string; toUserId: string }) =>
      api.post<Task>('/assignments/move', { taskId: task.key, fromUserId, toUserId }),
    onSuccess: (task) => {
      notify(`${task.key} reassigned`, 'success');
      void queryClient.invalidateQueries({ queryKey: ['capacity'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (error) => notify(error instanceof ApiError ? error.message : 'Reassignment failed', 'error'),
  });

  const assignUnassigned = useMutation({
    mutationFn: ({ task, toUserId }: { task: Task; toUserId: string }) =>
      api.put<Task>(`/assignments/tasks/${task.key}/assignees`, { userIds: [toUserId] }),
    onSuccess: (task) => {
      notify(`${task.key} assigned`, 'success');
      void queryClient.invalidateQueries({ queryKey: ['capacity'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (error) => notify(error instanceof ApiError ? error.message : 'Assignment failed', 'error'),
  });

  if (!teamId) {
    return (
      <>
        <PageHeader title="Capacity planner" />
        <EmptyState icon="◨" title="No team to plan" />
      </>
    );
  }
  if (capacityQuery.isPending) return <LoadingBlock rows={5} label="Loading capacity" />;
  if (capacityQuery.error) {
    return <ErrorBlock error={capacityQuery.error} onRetry={() => void capacityQuery.refetch()} />;
  }

  const capacity = capacityQuery.data;
  const tasks = tasksQuery.data ?? [];
  const unassigned = tasks.filter((task) => task.assignees.length === 0);
  const tasksByUser = new Map<string, Task[]>();
  for (const task of tasks) {
    for (const assignee of task.assignees) {
      tasksByUser.set(assignee.userId, [...(tasksByUser.get(assignee.userId) ?? []), task]);
    }
  }

  const weekOptions = Array.from({ length: 6 }, (_, index) =>
    isoWeekKey(new Date(Date.now() + index * 7 * 86_400_000)),
  );

  /** What the drop would do to this person, shown while dragging. */
  const projectionFor = (userId: string): string | null => {
    if (!dragging || dragging.fromUserId === userId) return null;
    const member = capacity.members.find((entry) => entry.userId === userId);
    if (!member) return null;
    const projected = member.capacity.plannedHours + dragging.task.remainingHours;
    const effective = member.capacity.effectiveCapacityHours;
    const utilization = effective === 0 ? Infinity : projected / effective;
    return `${formatHours(projected)} → ${formatPercent(utilization)}`;
  };

  return (
    <>
      <PageHeader
        title="Capacity planner"
        subtitle="Drag a task onto a teammate to move it. The projected load appears before you drop."
        actions={
          <>
            <label className="sr-only" htmlFor="planner-week">
              Week
            </label>
            <Select id="planner-week" value={week} onChange={(event) => setWeek(event.target.value)} style={{ width: 'auto' }}>
              {weekOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
            <TeamPicker teams={teams} teamId={teamId} onChange={setTeamId} />
          </>
        }
      />

      {unassigned.length > 0 && (
        <Card title={`Unassigned (${unassigned.length})`} >
          <div className="row row--wrap">
            {unassigned.map((task) => (
              <article
                key={task.id}
                className="task-card"
                style={{ width: 240 }}
                draggable
                onDragStart={() => setDragging({ task, fromUserId: '' })}
                onDragEnd={() => {
                  setDragging(null);
                  setDropTarget(null);
                }}
              >
                <span className="task-card__key">{task.key}</span>
                <p className="task-card__title">{task.title}</p>
                <div className="row row--between">
                  <span className="tiny numeric">{formatHours(task.remainingHours)}</span>
                  <Button variant="ghost" size="sm" onClick={() => setRecommendFor(task)}>
                    Suggest
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </Card>
      )}

      <div className="planner" style={{ marginTop: 'var(--space-4)' }}>
        {capacity.members.map((member) => {
          const projection = projectionFor(member.userId);
          return (
            <section
              key={member.userId}
              className={`planner__person${dropTarget === member.userId ? ' planner__person--drop' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDropTarget(member.userId);
              }}
              onDragLeave={() => setDropTarget((current) => (current === member.userId ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                setDropTarget(null);
                if (!dragging || dragging.fromUserId === member.userId) {
                  setDragging(null);
                  return;
                }
                if (dragging.fromUserId) {
                  reassign.mutate({ task: dragging.task, fromUserId: dragging.fromUserId, toUserId: member.userId });
                } else {
                  assignUnassigned.mutate({ task: dragging.task, toUserId: member.userId });
                }
                setDragging(null);
              }}
              aria-label={`${member.displayName}, ${formatPercent(member.capacity.utilization)} utilized`}
            >
              <div className="row row--between">
                <span className="row">
                  <Avatar name={member.displayName} src={member.avatarUrl} />
                  <span>
                    <span style={{ display: 'block', fontWeight: 600 }}>{member.displayName}</span>
                    <span className="tiny">{member.jobTitle ?? '—'}</span>
                  </span>
                </span>
                <BandBadge band={member.capacity.band} />
              </div>

              <div style={{ marginTop: 'var(--space-3)' }}>
                <UtilizationMeter
                  utilization={member.capacity.utilization}
                  band={member.capacity.band}
                  label={`${member.displayName} at ${formatPercent(member.capacity.utilization)}`}
                />
                <p className="tiny numeric" style={{ marginTop: 4 }}>
                  {formatHours(member.capacity.plannedHours)} planned of{' '}
                  {formatHours(member.capacity.effectiveCapacityHours)}
                  {member.capacity.leaveHours > 0 && ` · ${formatHours(member.capacity.leaveHours)} leave`}
                </p>
                {projection && (
                  <p className="tiny" style={{ color: 'var(--accent-text)', fontWeight: 600 }}>
                    After drop: {projection}
                  </p>
                )}
              </div>

              {member.skills.length > 0 && (
                <div className="row row--wrap" style={{ gap: 4, marginTop: 'var(--space-2)' }}>
                  {member.skills.slice(0, 4).map((skill) => (
                    <Badge key={skill}>{skill}</Badge>
                  ))}
                </div>
              )}

              {(() => {
                // Capacity is per person across every team, but this board
                // only lists the selected team's work. Naming the difference
                // stops "20h planned / no open work" looking like a bug.
                const visible = (tasksByUser.get(member.userId) ?? []).reduce(
                  (total, task) => total + task.remainingHours,
                  0,
                );
                const elsewhere = Math.round((member.capacity.plannedHours - visible) * 10) / 10;
                return elsewhere > 0.1 ? (
                  <p className="tiny" style={{ marginTop: 'var(--space-2)' }}>
                    {formatHours(elsewhere)} of this load sits in another team.
                  </p>
                ) : null;
              })()}

              <div className="planner__tasks">
                {(tasksByUser.get(member.userId) ?? []).map((task) => (
                  <article
                    key={task.id}
                    className="task-card"
                    draggable
                    onDragStart={() => setDragging({ task, fromUserId: member.userId })}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropTarget(null);
                    }}
                  >
                    <div className="row row--between">
                      <span className="task-card__key">{task.key}</span>
                      <span className="tiny numeric">{formatHours(task.remainingHours)}</span>
                    </div>
                    <p className="task-card__title" style={{ margin: '4px 0 0' }}>
                      {task.title}
                    </p>
                    <DueDate date={task.dueDate} />
                  </article>
                ))}
                {(tasksByUser.get(member.userId) ?? []).length === 0 && (
                  <p className="tiny">No open work for this team this week.</p>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {recommendFor && (
        <RecommendationPanel
          task={recommendFor}
          teamId={teamId}
          onClose={() => setRecommendFor(null)}
          onAssign={(userId) => {
            assignUnassigned.mutate({ task: recommendFor, toUserId: userId });
            setRecommendFor(null);
          }}
        />
      )}
    </>
  );
}

/** Ranked suggestions for who should take a task, with the reasoning shown. */
function RecommendationPanel({
  task,
  teamId,
  onClose,
  onAssign,
}: {
  task: Task;
  teamId: string;
  onClose: () => void;
  onAssign: (userId: string) => void;
}): JSX.Element {
  const { data, isPending } = useQuery({
    queryKey: ['recommend', task.id],
    queryFn: () =>
      api.get<{ recommendations: AssigneeRecommendation[] }>(
        `/assignments/recommend${qs({ taskId: task.key, teamId, estimatedHours: task.remainingHours, limit: 5 })}`,
      ),
  });

  return (
    <div className="modal-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Suggested assignees for ${task.key}`}>
        <header className="card__header">
          <div>
            <h2 className="card__title">Who should take {task.key}?</h2>
            <p className="tiny">Ranked on skill match and bandwidth left after the assignment.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </header>

        <div className="card__body">
          {isPending ? (
            <LoadingBlock rows={3} label="Ranking candidates" />
          ) : (data?.recommendations ?? []).length === 0 ? (
            <EmptyState icon="◔" title="No candidates" description="Nobody on this team is available." />
          ) : (
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {(data?.recommendations ?? []).map((recommendation, index) => (
                <li key={recommendation.userId} className="row row--between">
                  <span className="row">
                    <Avatar name={recommendation.displayName} />
                    <span>
                      <span style={{ display: 'block', fontWeight: 600 }}>
                        {index === 0 && <Badge tone="accent">Best fit</Badge>} {recommendation.displayName}
                      </span>
                      <span className="tiny">
                        {recommendation.matchedSkills.length > 0
                          ? `Has ${recommendation.matchedSkills.join(', ')}`
                          : 'No matching skills'}
                        {recommendation.missingSkills.length > 0 && ` · missing ${recommendation.missingSkills.join(', ')}`}
                        {' · would be at '}
                        {formatPercent(recommendation.projectedUtilization)}
                      </span>
                    </span>
                  </span>
                  <span className="row">
                    <BandBadge band={recommendation.band} />
                    <Button size="sm" onClick={() => onAssign(recommendation.userId)}>
                      Assign
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
