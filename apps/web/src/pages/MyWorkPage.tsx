import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { MemberDashboard } from '@teamspace/shared';
import { api } from '../api/client';
import {
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
  formatRelativeTime,
} from '../components/ui';
import { useAuth } from '../state/AuthContext';

/** The team member's home: what is due, how full the week is, what is unread. */
export function MyWorkPage(): JSX.Element {
  const { user } = useAuth();
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['dashboard', 'me'],
    queryFn: () => api.get<MemberDashboard>('/dashboard/me'),
  });

  if (isPending) return <LoadingBlock rows={5} label="Loading your work" />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  const { capacity } = data;
  const firstName = user?.displayName.split(' ')[0] ?? 'there';

  return (
    <>
      <PageHeader
        title={`Good to see you, ${firstName}`}
        subtitle={`Week ${data.weekKey} · ${data.todayTasks.length} task(s) in focus today`}
      />

      <div className="grid grid--metrics" style={{ marginBottom: 'var(--space-5)' }}>
        <Metric
          label="This week's load"
          value={formatHours(capacity.plannedHours)}
          hint={`of ${formatHours(capacity.effectiveCapacityHours)} available`}
        />
        <Metric label="Utilization" value={formatPercent(capacity.utilization)} tone={capacity.band} />
        <Metric
          label="Spare bandwidth"
          value={formatHours(capacity.availableHours)}
          hint={capacity.overAllocationHours > 0 ? `${formatHours(capacity.overAllocationHours)} over capacity` : 'Room for more'}
        />
        <Metric label="Overdue" value={data.overdueTasks.length} hint={data.overdueTasks.length ? 'Needs attention' : 'All on track'} />
      </div>

      <Card title="Your week">
        <div className="row" style={{ gap: 'var(--space-4)' }}>
          <div style={{ flex: 1 }}>
            <UtilizationMeter
              utilization={capacity.utilization}
              band={capacity.band}
              label={`Your utilization is ${formatPercent(capacity.utilization)}`}
            />
          </div>
          <BandBadge band={capacity.band} />
        </div>
        {capacity.leaveHours > 0 && (
          <p className="tiny" style={{ marginTop: 'var(--space-2)' }}>
            {formatHours(capacity.leaveHours)} of leave or holiday is already deducted from this week.
          </p>
        )}
      </Card>

      <div className="grid grid--halves" style={{ marginTop: 'var(--space-4)' }}>
        <Card title="Today">
          {data.todayTasks.length === 0 ? (
            <EmptyState icon="◔" title="Nothing scheduled for today" description="Enjoy the quiet, or pull something forward." />
          ) : (
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {data.todayTasks.map((task) => (
                <li key={task.id}>
                  <Link to={`/tasks/${task.key}`} className="row row--between" style={{ color: 'inherit' }}>
                    <span className="row" style={{ minWidth: 0 }}>
                      <PriorityDot priority={task.priority} />
                      <span className="truncate">{task.title}</span>
                    </span>
                    <span className="row" style={{ gap: 'var(--space-2)' }}>
                      <span className="tiny numeric">{formatHours(task.remainingHours)}</span>
                      <DueDate date={task.dueDate} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={`Due this week (${data.weekTasks.length})`}>
          {data.weekTasks.length === 0 ? (
            <EmptyState icon="▤" title="No deadlines this week" />
          ) : (
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {data.weekTasks.slice(0, 8).map((task) => (
                <li key={task.id} className="row row--between">
                  <Link to={`/tasks/${task.key}`} className="truncate">
                    {task.key} · {task.title}
                  </Link>
                  <DueDate date={task.dueDate} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {data.overdueTasks.length > 0 && (
        <Card title="Overdue" actions={<span className="badge badge--overloaded">{data.overdueTasks.length}</span>}>
          <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {data.overdueTasks.map((task) => (
              <li key={task.id} className="row row--between">
                <Link to={`/tasks/${task.key}`} className="truncate">
                  {task.key} · {task.title}
                </Link>
                <DueDate date={task.dueDate} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid grid--halves" style={{ marginTop: 'var(--space-4)' }}>
        <Card title="Recent conversations">
          {data.recentConversations.length === 0 ? (
            <EmptyState icon="◎" title="No conversations yet" />
          ) : (
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {data.recentConversations.map((conversation) => (
                <li key={conversation.id} className="row row--between">
                  <Link to={`/chat/${conversation.id}`} className="truncate">
                    {conversation.name ?? conversation.counterpart?.displayName ?? 'Direct message'}
                  </Link>
                  <span className="row" style={{ gap: 'var(--space-2)' }}>
                    {conversation.unreadCount > 0 && (
                      <span className="conversation-item__unread">{conversation.unreadCount}</span>
                    )}
                    {conversation.lastMessageAt && (
                      <span className="tiny">{formatRelativeTime(conversation.lastMessageAt)}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Mentions waiting on you">
          {data.pendingMentions.length === 0 ? (
            <EmptyState icon="@" title="No unread mentions" />
          ) : (
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {data.pendingMentions.map((mention) => (
                <li key={mention.id}>
                  <Link to={mention.link ?? '/chat'} className="truncate">
                    {mention.title}
                  </Link>
                  <p className="tiny truncate">{mention.body}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
