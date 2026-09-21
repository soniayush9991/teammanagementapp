import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ManagerDashboard } from '@teamspace/shared';
import { api, qs } from '../api/client';
import {
  Avatar,
  BandBadge,
  Card,
  DueDate,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Metric,
  PageHeader,
  PriorityDot,
  UtilizationMeter,
  formatHours,
  formatPercent,
} from '../components/ui';
import { useTeamSelection, TeamPicker } from '../components/TeamPicker';

/** The manager's control room: capacity, load distribution and what is slipping. */
export function TeamDashboardPage(): JSX.Element {
  const { teamId, setTeamId, teams } = useTeamSelection();

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['dashboard', 'manager', teamId],
    queryFn: () => api.get<ManagerDashboard>(`/dashboard/manager${qs({ teamId })}`),
    enabled: Boolean(teamId),
  });

  if (!teamId) {
    return (
      <>
        <PageHeader title="Team dashboard" />
        <EmptyState icon="◫" title="No team to show" description="You do not manage a team yet." />
      </>
    );
  }
  if (isPending) return <LoadingBlock rows={6} label="Loading the team dashboard" />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  const { rollup, members } = data.capacity;
  const maxPlanned = Math.max(1, ...data.workDistribution.map((entry) => entry.plannedHours));

  return (
    <>
      <PageHeader
        title="Team dashboard"
        subtitle={`Week ${data.weekKey} · ${rollup.memberCount} people`}
        actions={<TeamPicker teams={teams} teamId={teamId} onChange={setTeamId} />}
      />

      <div className="grid grid--metrics" style={{ marginBottom: 'var(--space-5)' }}>
        <Metric
          label="Team capacity"
          value={formatHours(rollup.totalEffectiveCapacityHours)}
          hint={`${formatHours(rollup.totalCapacityHours)} contracted, less leave`}
        />
        <Metric label="Planned work" value={formatHours(rollup.totalPlannedHours)} hint="Open assignments due this week" />
        <Metric label="Team utilization" value={formatPercent(rollup.utilization)} />
        <Metric
          label="Free bandwidth"
          value={formatHours(rollup.totalAvailableHours)}
          hint={rollup.totalOverAllocationHours > 0 ? `${formatHours(rollup.totalOverAllocationHours)} over-allocated elsewhere` : undefined}
        />
        <Metric label="Active assignments" value={data.activeAssignmentCount} />
        <Metric
          label="Overdue"
          value={data.overdueTaskCount}
          tone={data.overdueTaskCount > 0 ? 'overloaded' : undefined}
          hint={`${data.dueThisWeekCount} due this week`}
        />
      </div>

      <Card
        title="Bandwidth by person"
        actions={
          <span className="row" style={{ gap: 'var(--space-3)' }}>
            <span className="badge badge--overloaded">{rollup.overloadedCount} overloaded</span>
            <span className="badge badge--underutilized">{rollup.underutilizedCount} with room</span>
          </span>
        }
        flush
      >
        <table className="table">
          <caption className="sr-only">Capacity, planned hours and utilization for each team member</caption>
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col" className="th--numeric table__numeric">Capacity</th>
              <th scope="col" className="table__numeric th--numeric">Planned</th>
              <th scope="col" className="table__numeric th--numeric">Available</th>
              <th scope="col" style={{ width: 200 }}>Utilization</th>
              <th scope="col">Status</th>
              <th scope="col" className="th--numeric table__numeric">Open</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId}>
                <th scope="row" style={{ fontWeight: 500 }}>
                  <span className="row">
                    <Avatar name={member.displayName} src={member.avatarUrl} size="sm" />
                    <span>
                      <span style={{ display: 'block' }}>{member.displayName}</span>
                      <span className="tiny">{member.jobTitle ?? '—'}</span>
                    </span>
                  </span>
                </th>
                <td className="td--numeric numeric">{formatHours(member.capacity.effectiveCapacityHours)}</td>
                <td className="td--numeric numeric">{formatHours(member.capacity.plannedHours)}</td>
                <td className="td--numeric numeric">
                  {member.capacity.overAllocationHours > 0
                    ? `−${formatHours(member.capacity.overAllocationHours)}`
                    : formatHours(member.capacity.availableHours)}
                </td>
                <td>
                  <UtilizationMeter
                    utilization={member.capacity.utilization}
                    band={member.capacity.band}
                    label={`${member.displayName} is at ${formatPercent(member.capacity.utilization)} utilization`}
                  />
                  <span className="tiny numeric">{formatPercent(member.capacity.utilization)}</span>
                </td>
                <td>
                  <BandBadge band={member.capacity.band} />
                </td>
                <td className="td--numeric numeric">
                  {member.openTaskCount}
                  {member.overdueTaskCount > 0 && (
                    <span className="badge badge--overloaded" style={{ marginLeft: 6 }}>
                      {member.overdueTaskCount} late
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid grid--halves" style={{ marginTop: 'var(--space-4)' }}>
        <Card title="Work distribution">
          {data.workDistribution.length === 0 ? (
            <EmptyState icon="◔" title="No assignments yet" />
          ) : (
            <div className="bars">
              {data.workDistribution.map((entry) => (
                <div className="bar-row" key={entry.userId}>
                  <span className="truncate tiny">{entry.displayName}</span>
                  <div className="meter" title={`${formatHours(entry.plannedHours)} across ${entry.taskCount} tasks`}>
                    <div
                      className="meter__fill meter__fill--healthy"
                      style={{ width: `${(entry.plannedHours / maxPlanned) * 100}%` }}
                    />
                  </div>
                  <span className="tiny numeric">
                    {formatHours(entry.plannedHours)} · {entry.taskCount}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Upcoming deadlines">
          {data.upcomingDeadlines.length === 0 ? (
            <EmptyState icon="▤" title="Nothing due" description="No open task has a deadline." />
          ) : (
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {data.upcomingDeadlines.map((task) => (
                <li key={task.id} className="row row--between">
                  <span className="row" style={{ minWidth: 0 }}>
                    <PriorityDot priority={task.priority} />
                    <Link to={`/tasks/${task.key}`} className="truncate">
                      {task.title}
                    </Link>
                  </span>
                  <DueDate date={task.dueDate} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Status breakdown" >
        <div className="row row--wrap" style={{ gap: 'var(--space-4)' }}>
          {data.statusBreakdown.map((entry) => (
            <div key={entry.status}>
              <p className="metric__label">{entry.status.replace('_', ' ')}</p>
              <p className="metric__value" style={{ fontSize: 'var(--text-xl)' }}>
                {entry.count}
              </p>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
