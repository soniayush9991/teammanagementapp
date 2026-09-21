import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, downloadReport, qs } from '../api/client';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  UtilizationMeter,
  formatHours,
  formatPercent,
} from '../components/ui';
import { TeamPicker, useTeamSelection } from '../components/TeamPicker';
import { useToast } from '../state/ToastContext';

type ReportName = 'workload' | 'utilization' | 'completion-trend' | 'overdue' | 'productivity';

const REPORTS: { id: ReportName; label: string; description: string }[] = [
  { id: 'workload', label: 'Employee workload', description: 'Capacity, planned hours and utilization per person.' },
  { id: 'utilization', label: 'Capacity utilization', description: 'Team utilization week by week.' },
  { id: 'completion-trend', label: 'Completion trend', description: 'Created versus completed, day by day.' },
  { id: 'overdue', label: 'Overdue tasks', description: 'Everything past its due date and who holds it.' },
  { id: 'productivity', label: 'Team productivity', description: 'Throughput, logged hours and cycle time.' },
];

export function ReportsPage(): JSX.Element {
  const { teamId, setTeamId, teams } = useTeamSelection();
  const { notify } = useToast();
  const [report, setReport] = useState<ReportName>('workload');

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['reports', report, teamId],
    queryFn: () => api.get<Record<string, unknown>>(`/reports/${report}${qs({ teamId })}`),
    enabled: Boolean(teamId),
  });

  const exportAs = async (format: 'csv' | 'pdf'): Promise<void> => {
    try {
      await downloadReport(`/reports/${report}/export${qs({ teamId, format })}`, `${report}.${format}`);
      notify(`${format.toUpperCase()} downloaded`, 'success');
    } catch {
      notify('The export could not be generated', 'error');
    }
  };

  const active = REPORTS.find((entry) => entry.id === report)!;

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={active.description}
        actions={
          <>
            <TeamPicker teams={teams} teamId={teamId} onChange={setTeamId} />
            <Button variant="secondary" onClick={() => void exportAs('csv')}>
              Export CSV
            </Button>
            <Button variant="secondary" onClick={() => void exportAs('pdf')}>
              Export PDF
            </Button>
          </>
        }
      />

      <div className="row row--wrap" style={{ marginBottom: 'var(--space-4)' }}>
        {REPORTS.map((entry) => (
          <Button
            key={entry.id}
            variant={entry.id === report ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setReport(entry.id)}
            aria-pressed={entry.id === report}
          >
            {entry.label}
          </Button>
        ))}
      </div>

      {!teamId ? (
        <EmptyState icon="◔" title="No team selected" />
      ) : isPending ? (
        <LoadingBlock rows={6} label="Building the report" />
      ) : error ? (
        <ErrorBlock error={error} onRetry={() => void refetch()} />
      ) : (
        <Card flush>
          <ReportTable report={report} data={data} />
        </Card>
      )}
    </>
  );
}

interface WorkloadRow {
  userId: string;
  displayName: string;
  jobTitle: string | null;
  weeklyCapacityHours: number;
  leaveHours: number;
  plannedHours: number;
  availableHours: number;
  overAllocationHours: number;
  utilization: number;
  band: 'healthy' | 'near_capacity' | 'overloaded' | 'underutilized';
  openTaskCount: number;
  overdueTaskCount: number;
}

function ReportTable({ report, data }: { report: ReportName; data: Record<string, unknown> }): JSX.Element {
  const rows = (data.rows ?? []) as unknown[];
  if (rows.length === 0) {
    return <EmptyState icon="◔" title="Nothing to report" description="No data in this range." />;
  }

  switch (report) {
    case 'workload': {
      const typed = rows as WorkloadRow[];
      return (
        <table className="table">
          <caption className="sr-only">Employee workload report</caption>
          <thead>
            <tr>
              <th scope="col">Employee</th>
              <th scope="col" className="th--numeric">Capacity</th>
              <th scope="col" className="th--numeric">Leave</th>
              <th scope="col" className="th--numeric">Planned</th>
              <th scope="col" className="th--numeric">Available</th>
              <th scope="col">Utilization</th>
              <th scope="col" className="th--numeric">Open</th>
            </tr>
          </thead>
          <tbody>
            {typed.map((row) => (
              <tr key={row.userId}>
                <th scope="row" style={{ fontWeight: 500 }}>
                  {row.displayName}
                  <br />
                  <span className="tiny">{row.jobTitle ?? '—'}</span>
                </th>
                <td className="td--numeric numeric">{formatHours(row.weeklyCapacityHours)}</td>
                <td className="td--numeric numeric">{formatHours(row.leaveHours)}</td>
                <td className="td--numeric numeric">{formatHours(row.plannedHours)}</td>
                <td className="td--numeric numeric">
                  {row.overAllocationHours > 0 ? `−${formatHours(row.overAllocationHours)}` : formatHours(row.availableHours)}
                </td>
                <td style={{ minWidth: 160 }}>
                  <UtilizationMeter utilization={row.utilization} band={row.band} label={`${row.displayName} utilization`} />
                  <span className="tiny numeric">{formatPercent(row.utilization)}</span>
                </td>
                <td className="td--numeric numeric">
                  {row.openTaskCount}
                  {row.overdueTaskCount > 0 && <Badge tone="overloaded">{row.overdueTaskCount} late</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case 'utilization': {
      const typed = rows as { weekKey: string; capacityHours: number; plannedHours: number; utilization: number; overloadedCount: number }[];
      const peak = Math.max(1, ...typed.map((row) => row.utilization));
      return (
        <div className="card__body">
          <div className="bars">
            {typed.map((row) => (
              <div className="bar-row" key={row.weekKey}>
                <span className="tiny">{row.weekKey}</span>
                <div className="meter" title={`${formatHours(row.plannedHours)} of ${formatHours(row.capacityHours)}`}>
                  <div
                    className={`meter__fill meter__fill--${row.utilization > 1 ? 'overloaded' : row.utilization >= 0.85 ? 'near_capacity' : 'healthy'}`}
                    style={{ width: `${(row.utilization / peak) * 100}%` }}
                  />
                </div>
                <span className="tiny numeric">{formatPercent(row.utilization)}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    case 'completion-trend': {
      const typed = rows as { day: string; createdCount: number; completedCount: number; loggedHours: number }[];
      const peak = Math.max(1, ...typed.map((row) => Math.max(row.createdCount, row.completedCount)));
      return (
        <div className="card__body">
          <div className="row" style={{ alignItems: 'flex-end', gap: 4, height: 160 }}>
            {typed.map((row) => (
              <div key={row.day} className="stack" style={{ flex: 1, gap: 2, alignItems: 'center' }} title={`${row.day}: ${row.createdCount} created, ${row.completedCount} completed`}>
                <div className="row" style={{ alignItems: 'flex-end', gap: 2, height: 120 }}>
                  <div style={{ width: 6, height: `${(row.createdCount / peak) * 120}px`, background: 'var(--band-under)', borderRadius: 2 }} />
                  <div style={{ width: 6, height: `${(row.completedCount / peak) * 120}px`, background: 'var(--band-healthy)', borderRadius: 2 }} />
                </div>
              </div>
            ))}
          </div>
          <div className="row" style={{ gap: 'var(--space-4)', marginTop: 'var(--space-3)' }}>
            <span className="row tiny"><span style={{ width: 10, height: 10, background: 'var(--band-under)', borderRadius: 2 }} /> Created</span>
            <span className="row tiny"><span style={{ width: 10, height: 10, background: 'var(--band-healthy)', borderRadius: 2 }} /> Completed</span>
          </div>
        </div>
      );
    }
    case 'overdue': {
      const typed = rows as { taskKey: string; title: string; status: string; priority: string; dueDate: string | null; daysOverdue: number; assignees: string; remainingHours: number }[];
      return (
        <table className="table">
          <caption className="sr-only">Overdue task report</caption>
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">Assignees</th>
              <th scope="col">Due</th>
              <th scope="col" className="th--numeric">Days late</th>
              <th scope="col" className="th--numeric">Remaining</th>
            </tr>
          </thead>
          <tbody>
            {typed.map((row) => (
              <tr key={row.taskKey}>
                <th scope="row" style={{ fontWeight: 500 }}>
                  {row.taskKey} · {row.title}
                  <br />
                  <span className="tiny">{row.status.replace('_', ' ')} · {row.priority}</span>
                </th>
                <td>{row.assignees}</td>
                <td>{row.dueDate}</td>
                <td className="td--numeric numeric">
                  <Badge tone="overloaded">{row.daysOverdue}</Badge>
                </td>
                <td className="td--numeric numeric">{formatHours(row.remainingHours)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case 'productivity':
    default: {
      const typed = rows as { userId: string; displayName: string; completedTasks: number; loggedHours: number; avgCycleTimeDays: number; overdueTasks: number }[];
      return (
        <table className="table">
          <caption className="sr-only">Team productivity report</caption>
          <thead>
            <tr>
              <th scope="col">Employee</th>
              <th scope="col" className="th--numeric">Completed</th>
              <th scope="col" className="th--numeric">Logged</th>
              <th scope="col" className="th--numeric">Avg cycle time</th>
              <th scope="col" className="th--numeric">Overdue now</th>
            </tr>
          </thead>
          <tbody>
            {typed.map((row) => (
              <tr key={row.userId}>
                <th scope="row" style={{ fontWeight: 500 }}>{row.displayName}</th>
                <td className="td--numeric numeric">{row.completedTasks}</td>
                <td className="td--numeric numeric">{formatHours(row.loggedHours)}</td>
                <td className="td--numeric numeric">{row.avgCycleTimeDays} days</td>
                <td className="td--numeric numeric">{row.overdueTasks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
  }
}
