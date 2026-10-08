import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useScoreList, type ScoreListItem } from '../../api/mentorAdmin';
import { Card, EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui';
import { DeltaChip, StatusBadge } from '../../components/mentor/parts';
import { formatCount } from '../../components/mentor/format';
import { FilterBar, oneDecimal, useFilters } from '../../components/mentorAdmin/parts';

type SortKey = 'name' | 'overall' | 'compliance' | 'reliability' | 'delta' | 'flags';

const SORTERS: Record<SortKey, (item: ScoreListItem) => number | string> = {
  name: (item) => item.name.toLowerCase(),
  overall: (item) => item.overall ?? -1,
  compliance: (item) => item.compliance ?? -1,
  reliability: (item) => item.reliability ?? -1,
  delta: (item) => item.delta ?? -999,
  flags: (item) => item.flags.flagged + item.flags.confirmed,
};

/** A2: every mentor in scope for the period, sortable, with a way into each one. */
export function MentorsPage(): JSX.Element {
  const { filters, query } = useFilters();
  const { data, isPending, error, refetch } = useScoreList(filters);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });

  const rows = useMemo(() => {
    const pick = SORTERS[sort.key];
    return [...(data?.items ?? [])].sort((a, b) => {
      const left = pick(a);
      const right = pick(b);
      return (left < right ? -1 : left > right ? 1 : 0) * sort.dir;
    });
  }, [data, sort]);

  const header = (key: SortKey, label: string, numeric = false): JSX.Element => (
    <th scope="col" className={numeric ? 'th--numeric' : undefined} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sort-button" onClick={() => setSort((current) => ({ key, dir: current.key === key ? (current.dir === 1 ? -1 : 1) : 1 }))}>
        {label}
        <span aria-hidden="true">{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</span>
      </button>
    </th>
  );

  return (
    <div className="stack">
      <FilterBar showStatus />
      {isPending && <LoadingBlock rows={6} label="Loading mentors" />}
      {error && <ErrorBlock error={error} onRetry={() => void refetch()} />}
      {data && rows.length === 0 && (
        <Card>
          <EmptyState icon="◔" title="No mentors match" description="Try a different period or clear a filter." />
        </Card>
      )}
      {data && rows.length > 0 && (
        <Card flush>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  {header('name', 'Mentor')}
                  {header('overall', 'Overall', true)}
                  {header('compliance', 'Compliance', true)}
                  {header('reliability', 'Reliability', true)}
                  {header('delta', 'Trend')}
                  {header('flags', 'Flags')}
                  <th scope="col" className="th--numeric">Visits</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => {
                  const hasScore = item.overall !== null;
                  return (
                    <tr key={item.mentorId}>
                      <th scope="row">
                        <Link to={`/mentor-admin/mentors/${item.mentorId}${query}`}>{item.name}</Link>
                        <span className="tiny block">{[item.role, item.district, item.block].filter(Boolean).join(' · ')}</span>
                      </th>
                      <td className="td--numeric">
                        {hasScore ? <strong>{oneDecimal(item.overall)}</strong> : '—'}
                        <span className="block"><StatusBadge status={item.status} /></span>
                      </td>
                      <td className="td--numeric">{oneDecimal(item.compliance)}</td>
                      <td className="td--numeric">{oneDecimal(item.reliability)}</td>
                      <td>{hasScore ? <DeltaChip delta={item.delta} label="" /> : '—'}</td>
                      <td>
                        {item.flags.flagged} flagged · {item.flags.confirmed} confirmed
                      </td>
                      <td className="td--numeric">
                        {formatCount(item.visits.valid)} / {formatCount(item.visits.expected)}
                      </td>
                      <td className="row-actions">
                        <Link className="btn btn--ghost btn--sm" to={`/mentor-admin/mentors/${item.mentorId}${query}`}>Report card</Link>
                        <Link className="btn btn--ghost btn--sm" to={`/mentor-admin/flags?mentor=${item.mentorId}`}>Audit history</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {data && <p className="tiny">{data.total} mentors · scores shown to one decimal; mentors see whole points.</p>}
    </div>
  );
}
