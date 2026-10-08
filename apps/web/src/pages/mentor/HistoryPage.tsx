import { Link } from 'react-router-dom';
import { useScoreHistory } from '../../api/mentor';
import { Card, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { DeltaChip, NoReportCard, ReportCardTabs, StatusBadge } from '../../components/mentor/parts';
import { formatPeriod, formatPoints } from '../../components/mentor/format';

/** M6: completed periods, newest first. Opening one shows it as it was calculated. */
export function HistoryPage(): JSX.Element {
  const { data, isPending, error, refetch } = useScoreHistory();

  if (isPending) return <LoadingBlock rows={5} label="Loading your history" />;
  if (error || !data) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  if (data.items.length === 0) {
    return (
      <>
        <PageHeader title="Score history" />
        <NoReportCard />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Score history" subtitle="Each report card keeps the rules it was calculated with." />
      <ReportCardTabs periodId={data.items[0]!.periodId} />
      <Card flush>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col" className="th--numeric">Overall</th>
              <th scope="col" className="th--numeric">Compliance</th>
              <th scope="col" className="th--numeric">Reliability</th>
              <th scope="col">Status</th>
              <th scope="col">Change</th>
              <th scope="col"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.periodId}>
                <th scope="row">{formatPeriod(item.startDate, item.endDate)}</th>
                <td className="td--numeric">{formatPoints(item.overall)}</td>
                <td className="td--numeric">{formatPoints(item.compliance)}</td>
                <td className="td--numeric">{formatPoints(item.reliability)}</td>
                <td>
                  <StatusBadge status={item.status} />
                  {item.revision > 1 && <span className="tiny"> · Updated</span>}
                </td>
                <td>{item.overall === null ? '—' : <DeltaChip delta={item.delta} label="" />}</td>
                <td>
                  <Link className="btn btn--ghost btn--sm" to={`/mentor/${item.periodId}`}>
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="tiny" style={{ marginTop: 'var(--space-3)' }}>
        Changing the scoring settings later never alters a report card that has already been published.
      </p>
    </>
  );
}
