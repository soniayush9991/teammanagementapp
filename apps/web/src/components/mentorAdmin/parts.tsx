import { useMemo, type ReactNode } from 'react';
import { NavLink, Outlet, useSearchParams } from 'react-router-dom';
import { useFilterOptions, usePeriods, type Filters } from '../../api/mentorAdmin';
import { formatPeriod } from '../mentor/format';
import { useAuth } from '../../state/AuthContext';
import { PageHeader, Select } from '../ui';

/* ---------------------------------------------------------------------------
   Shared pieces for the reviewer/admin mentor-scoring screens (A1-A7).
   Filters live in the URL so a view can be linked, reloaded and shared.
   --------------------------------------------------------------------------- */

const KEYS = ['period', 'district', 'block', 'role', 'status'] as const;

export function useFilters(): { filters: Filters; set: (patch: Partial<Filters>) => void; query: string } {
  const [params, setParams] = useSearchParams();
  const filters: Filters = {};
  for (const key of KEYS) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  const set = (patch: Partial<Filters>): void => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    // A block belongs to one district, so changing district clears it.
    if ('district' in patch) next.delete('block');
    setParams(next, { replace: true });
  };
  return { filters, set, query: params.toString() ? `?${params.toString()}` : '' };
}

export const oneDecimal = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : String(Math.round(value * 10) / 10);

export const percentText = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : `${oneDecimal(value)}%`;

/** Closed periods only: those are the ones with scores to look at. */
export function PeriodSelect({ value, onChange, includeOpen = false }: { value?: string; onChange: (id: string) => void; includeOpen?: boolean }): JSX.Element {
  const { data } = usePeriods();
  const periods = (data?.items ?? []).filter((period) => includeOpen || period.status === 'closed');
  return (
    <label className="filter">
      <span className="filter__label">Period</span>
      <Select value={value ?? ''} onChange={(event) => onChange(event.target.value)} aria-label="Scoring period">
        <option value="">Latest closed</option>
        {periods.map((period) => (
          <option key={period.id} value={period.id}>
            {formatPeriod(period.start_date, period.end_date)}
            {period.status === 'open' ? ' (open)' : period.published_at ? '' : ' (not published)'}
          </option>
        ))}
      </Select>
    </label>
  );
}

export function FilterBar({ showPeriod = true, showStatus = false }: { showPeriod?: boolean; showStatus?: boolean }): JSX.Element {
  const { filters, set } = useFilters();
  const { data: options } = useFilterOptions();
  const blocks = useMemo(
    () => (options?.blocks ?? []).filter((entry) => !filters.district || entry.district === filters.district),
    [options, filters.district],
  );

  return (
    <div className="filters" role="group" aria-label="Filters">
      {showPeriod && <PeriodSelect value={filters.period} onChange={(period) => set({ period })} />}
      <label className="filter">
        <span className="filter__label">District</span>
        <Select value={filters.district ?? ''} onChange={(event) => set({ district: event.target.value })} aria-label="District">
          <option value="">All districts</option>
          {options?.districts.map((district) => <option key={district}>{district}</option>)}
        </Select>
      </label>
      <label className="filter">
        <span className="filter__label">Block</span>
        <Select value={filters.block ?? ''} onChange={(event) => set({ block: event.target.value })} aria-label="Block">
          <option value="">All blocks</option>
          {blocks.map((entry) => <option key={`${entry.district}-${entry.block}`}>{entry.block}</option>)}
        </Select>
      </label>
      <label className="filter">
        <span className="filter__label">Role</span>
        <Select value={filters.role ?? ''} onChange={(event) => set({ role: event.target.value })} aria-label="Role">
          <option value="">All roles</option>
          {options?.roles.map((role) => <option key={role}>{role}</option>)}
        </Select>
      </label>
      {showStatus && (
        <label className="filter">
          <span className="filter__label">Status</span>
          <Select value={filters.status ?? ''} onChange={(event) => set({ status: event.target.value })} aria-label="Score status">
            <option value="">Any status</option>
            <option value="final">Final</option>
            <option value="provisional">Provisional</option>
            <option value="insufficient_data">Insufficient data</option>
          </Select>
        </label>
      )}
    </div>
  );
}

/** Frame and section navigation for /mentor-admin/*. */
export function MentorAdminLayout(): JSX.Element {
  const { can } = useAuth();
  const { query } = useFilters();
  const tabs: [string, string, boolean, boolean?][] = [
    ['/mentor-admin', 'Overview', true],
    ['/mentor-admin/mentors', 'Mentors', false],
    ['/mentor-admin/flags', 'Flag queue', false],
    ['/mentor-admin/recognition', 'Recognition', false],
    ['/mentor-admin/benchmarks', 'Benchmarks', false],
  ];
  return (
    <>
      <PageHeader
        title="Mentor scoring"
        subtitle="Data-reliability and coverage scores, flag review and configuration. A feedback tool, not an appraisal."
      />
      <nav className="tabs" aria-label="Mentor scoring sections">
        {tabs.map(([to, label, end]) => (
          <NavLink key={to} to={`${to}${to === '/mentor-admin' || to.endsWith('mentors') ? query : ''}`} end={end} className={({ isActive }) => `tabs__tab${isActive ? ' tabs__tab--active' : ''}`}>
            {label}
          </NavLink>
        ))}
        {can('mentor_score:configure') && (
          <NavLink to="/mentor-admin/config" className={({ isActive }) => `tabs__tab${isActive ? ' tabs__tab--active' : ''}`}>
            Configuration
          </NavLink>
        )}
      </nav>
      <Outlet />
    </>
  );
}

/* ---- charts: one hue, thin marks, direct labels, a table behind each ----- */

/** Count per score band. Bars share one hue; the band is the only thing that varies. */
export function Histogram({ bins, label }: { bins: { label: string; count: number }[]; label: string }): JSX.Element {
  const max = Math.max(1, ...bins.map((bin) => bin.count));
  return (
    <figure className="histogram" aria-label={label}>
      <div className="histogram__bars">
        {bins.map((bin) => (
          <div key={bin.label} className="histogram__col" title={`${bin.label}: ${bin.count} ${bin.count === 1 ? 'mentor' : 'mentors'}`}>
            <span className="histogram__count">{bin.count}</span>
            <span className="histogram__bar" style={{ height: `${(bin.count / max) * 100}%` }} />
            <span className="histogram__label">{bin.label}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

/** Median and quartiles as a written strip, so the average never stands alone. */
export function QuartileStrip({ distribution }: { distribution: { min: number | null; q1: number | null; median: number | null; q3: number | null; max: number | null } }): JSX.Element {
  const items: [string, number | null][] = [['Lowest', distribution.min], ['Q1', distribution.q1], ['Median', distribution.median], ['Q3', distribution.q3], ['Highest', distribution.max]];
  return (
    <dl className="quartiles">
      {items.map(([name, value]) => (
        <div key={name} className={name === 'Median' ? 'quartiles__item quartiles__item--median' : 'quartiles__item'}>
          <dt>{name}</dt>
          <dd>{oneDecimal(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A single-series line over periods (0-100). Two measures get two charts, never
 * two axes. The last point is labelled directly; the data is also in a table.
 */
export function TrendLine({ title, points }: { title: string; points: { label: string; value: number | null }[] }): JSX.Element {
  const width = 360;
  const height = 150;
  const pad = { left: 30, right: 36, top: 14, bottom: 22 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const x = (index: number): number => pad.left + (points.length <= 1 ? plotW / 2 : (index / (points.length - 1)) * plotW);
  const y = (value: number): number => pad.top + plotH - (Math.max(0, Math.min(100, value)) / 100) * plotH;
  const known = points.map((point, index) => (point.value === null ? null : { index, value: point.value }));
  const path = known.filter((point): point is { index: number; value: number } => point !== null)
    .map((point, order) => `${order === 0 ? 'M' : 'L'}${x(point.index).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ');
  const last = [...known].reverse().find((point) => point !== null);

  return (
    <figure className="trendline">
      <figcaption className="trendline__title">{title}</figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}: ${points.map((p) => `${p.label} ${oneDecimal(p.value)}`).join(', ')}`}>
        {[0, 50, 100].map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} className="trendline__grid" />
            <text x={pad.left - 6} y={y(tick) + 4} textAnchor="end" className="trendline__tick">{tick}</text>
          </g>
        ))}
        {path && <path d={path} className="trendline__path" fill="none" />}
        {known.map((point) =>
          point ? (
            <circle key={point.index} cx={x(point.index)} cy={y(point.value)} r={4} className="trendline__dot">
              <title>{`${points[point.index]!.label}: ${oneDecimal(point.value)}`}</title>
            </circle>
          ) : null,
        )}
        {last && (
          <text x={x(last.index) + 8} y={y(last.value) + 4} className="trendline__end">{oneDecimal(last.value)}</text>
        )}
        {points.map((point, index) => (
          <text key={point.label} x={x(index)} y={height - 6} textAnchor="middle" className="trendline__tick">{point.label}</text>
        ))}
      </svg>
    </figure>
  );
}

export function Section({ children }: { children: ReactNode }): JSX.Element {
  return <div className="stack">{children}</div>;
}
