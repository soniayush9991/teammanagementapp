import { Link } from 'react-router-dom';
import { useScoreList, useTrend, type TrendItem } from '../../api/mentorAdmin';
import { Card, EmptyState, ErrorBlock, LoadingBlock, Metric } from '../../components/ui';
import { formatPeriod } from '../../components/mentor/format';
import { FilterBar, Histogram, QuartileStrip, TrendLine, oneDecimal, percentText, useFilters } from '../../components/mentorAdmin/parts';

const shortLabel = (item: TrendItem): string => formatPeriod(item.startDate, item.endDate).split(' – ')[0]!;

/** A1: how the programme is doing, as a distribution and a trend, never just an average. */
export function OverviewPage(): JSX.Element {
  const { filters, query } = useFilters();
  const scores = useScoreList(filters);
  const trend = useTrend(filters, 6);

  return (
    <div className="stack">
      <FilterBar />

      {scores.isPending && <LoadingBlock rows={4} label="Loading the overview" />}
      {scores.error && <ErrorBlock error={scores.error} onRetry={() => void scores.refetch()} />}
      {scores.data && scores.data.summary.mentors === 0 && (
        <Card>
          <EmptyState icon="◔" title="No scores for this selection" description="Close a scoring period, or widen the filters." />
        </Card>
      )}

      {scores.data && scores.data.summary.mentors > 0 && (
        <>
          <p className="muted">
            {formatPeriod(scores.data.period.startDate, scores.data.period.endDate)} ·{' '}
            {scores.data.period.published ? 'Published to mentors' : 'Shadow mode — mentors cannot see these scores yet'}
          </p>
          <div className="grid grid--metrics">
            <Metric label="Mentors scored" value={scores.data.summary.mentors} />
            <Metric label="Average score" value={oneDecimal(scores.data.summary.averageScore)} hint={`Median ${oneDecimal(scores.data.summary.medianScore)}`} />
            <Metric label="Final" value={percentText(scores.data.summary.percentFinal)} hint={`${percentText(scores.data.summary.percentProvisional)} provisional`} />
            <Metric label="Valid visit coverage" value={percentText(scores.data.summary.validVisitCoverage)} hint="Counted ÷ expected visits" />
            <Metric label="Confirmed integrity issues" value={percentText(scores.data.summary.confirmedIntegrityIssueRate)} hint="Of all quality checks" />
          </div>

          <div className="grid grid--halves">
            <Card title="Score distribution" actions={<Link className="btn btn--ghost btn--sm" to={`/mentor-admin/mentors${query}`}>See mentors</Link>}>
              <Histogram bins={scores.data.summary.histogram} label="Number of mentors in each overall score band" />
              <QuartileStrip distribution={scores.data.summary.distribution} />
              <p className="tiny">Mentors with no score (insufficient data) are not in the chart.</p>
            </Card>

            <Card title="Data integrity">
              <IntegrityPanel items={trend.data?.items ?? []} loading={trend.isPending} />
            </Card>
          </div>

          <Card title="Trend over the last periods">
            {trend.isPending && <LoadingBlock rows={3} label="Loading the trend" />}
            {trend.error && <ErrorBlock error={trend.error} onRetry={() => void trend.refetch()} />}
            {trend.data && trend.data.items.length > 0 && (
              <>
                <div className="grid grid--halves">
                  <TrendLine title="Average compliance" points={trend.data.items.map((item) => ({ label: shortLabel(item), value: item.compliance }))} />
                  <TrendLine title="Average data reliability" points={trend.data.items.map((item) => ({ label: shortLabel(item), value: item.reliability }))} />
                </div>
                <details className="visit-list">
                  <summary>Show the numbers</summary>
                  <table className="table" style={{ marginTop: 'var(--space-2)' }}>
                    <thead>
                      <tr>
                        <th scope="col">Period</th>
                        <th scope="col" className="th--numeric">Mentors</th>
                        <th scope="col" className="th--numeric">Compliance</th>
                        <th scope="col" className="th--numeric">Reliability</th>
                        <th scope="col" className="th--numeric">Coverage</th>
                        <th scope="col" className="th--numeric">Final</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trend.data.items.map((item) => (
                        <tr key={item.periodId}>
                          <th scope="row">{formatPeriod(item.startDate, item.endDate)}</th>
                          <td className="td--numeric">{item.mentors}</td>
                          <td className="td--numeric">{oneDecimal(item.compliance)}</td>
                          <td className="td--numeric">{oneDecimal(item.reliability)}</td>
                          <td className="td--numeric">{percentText(item.coverage)}</td>
                          <td className="td--numeric">{percentText(item.percentFinal)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/** Inflation and contradiction, confirmed versus still flagged, for the latest period in the trend. */
function IntegrityPanel({ items, loading }: { items: TrendItem[]; loading: boolean }): JSX.Element {
  const latest = items.at(-1);
  if (loading) return <LoadingBlock rows={3} label="Loading integrity figures" />;
  if (!latest) return <p className="muted">No closed periods yet.</p>;
  const rows: [string, TrendItem['inflation']][] = [
    ['Inflation', latest.inflation],
    ['Contradiction', latest.contradiction],
  ];
  return (
    <>
      <p className="tiny">{formatPeriod(latest.startDate, latest.endDate)}</p>
      <div className="table-scroll">
      <table className="table table--compact">
        <thead>
          <tr>
            <th scope="col">Kind</th>
            <th scope="col" className="th--numeric">Confirmed</th>
            <th scope="col" className="th--numeric">Flagged</th>
            <th scope="col" className="th--numeric">Dismissed</th>
            <th scope="col" className="th--numeric">Rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, counts]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td className="td--numeric">{counts.confirmed}</td>
              <td className="td--numeric">{counts.flagged}</td>
              <td className="td--numeric">{counts.dismissed}</td>
              <td className="td--numeric">{percentText(counts.rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <p className="tiny">
        Confirmed, flagged and dismissed count issues on this period's visits. Rate is the share of quality checks whose
        confirmed issue was applied to a score in this period. A flag is a question, not a finding.
      </p>
    </>
  );
}
