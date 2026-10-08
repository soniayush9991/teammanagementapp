import { Link } from 'react-router-dom';
import { useBenchmarks } from '../../api/mentorAdmin';
import { Badge, Card, EmptyState, ErrorBlock, LoadingBlock, formatRelativeTime } from '../../components/ui';
import { formatPeriod } from '../../components/mentor/format';
import { PeriodSelect, oneDecimal, useFilters } from '../../components/mentorAdmin/parts';
import { useAuth } from '../../state/AuthContext';

/** A6: the frozen benchmark behind each "district median" a mentor sees, and exactly how it was made. */
export function BenchmarksPage(): JSX.Element {
  const { filters, set } = useFilters();
  const { data, isPending, error, refetch } = useBenchmarks(filters.period);
  const { can } = useAuth();

  return (
    <div className="stack">
      <div className="filters">
        <PeriodSelect value={filters.period} onChange={(period) => set({ period })} />
      </div>

      <Card title="How benchmarks work">
        <ul className="plain-list">
          <li>The benchmark is the <strong>median</strong> overall score of a cohort, used for context only; mentors are never ranked against it.</li>
          <li>Each mentor contributes exactly one value, and a median ignores a single extreme score, so no one mentor can pull it.</li>
          <li>
            It is hidden when fewer than {data?.minCohortSize ?? 'the minimum'} mentors are in the cohort, so it cannot identify an individual.
            {can('mentor_score:configure') && <> Change that on the <Link to="/mentor-admin/config">Configuration</Link> screen.</>}
          </li>
          <li>Snapshots are taken when a period closes and never change afterwards.</li>
        </ul>
      </Card>

      {isPending && <LoadingBlock rows={4} label="Loading benchmarks" />}
      {error && <ErrorBlock error={error} onRetry={() => void refetch()} />}
      {data && data.items.length === 0 && (
        <Card>
          <EmptyState icon="◔" title="No benchmarks for this period" description="Benchmarks are created when a period closes, from mentors who have a score." />
        </Card>
      )}
      {data && data.items.length > 0 && (
        <Card title={formatPeriod(data.period.startDate, data.period.endDate)} flush>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Cohort</th>
                  <th scope="col">Role</th>
                  <th scope="col">Statistic</th>
                  <th scope="col" className="th--numeric">Value</th>
                  <th scope="col" className="th--numeric">Cohort size</th>
                  <th scope="col">Data window</th>
                  <th scope="col">Cap method</th>
                  <th scope="col">Calculated</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id}>
                    <th scope="row">
                      {item.geography}
                      {item.members && (
                        <details className="visit-list">
                          <summary>Members</summary>
                          <p className="muted">{item.members.map((member) => member.name).join(', ')}</p>
                        </details>
                      )}
                    </th>
                    <td>{item.role}</td>
                    <td>{item.statistic}</td>
                    <td className="td--numeric">{item.suppressed ? <Badge tone="underutilized">○ Hidden</Badge> : oneDecimal(item.value)}</td>
                    <td className="td--numeric">{item.cohortSize}</td>
                    <td>{item.dataWindow ? `${item.dataWindow[0]} → ${item.dataWindow[1]}` : '—'}</td>
                    <td>{item.capMethod.replaceAll('_', ' ')}</td>
                    <td>{formatRelativeTime(item.calculatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
