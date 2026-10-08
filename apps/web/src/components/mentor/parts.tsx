import type { ReactNode } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { useReportCard, type MentorMetric, type ReportCard, type ScoreStatus } from '../../api/mentor';
import { Badge, Card, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../ui';
import {
  METRIC_COPY,
  STATUS_EXPLAINER,
  STATUS_LABEL,
  describeDelta,
  describeStatusReasons,
  formatCount,
  formatDay,
  formatPeriod,
} from './format';

/* ---------------------------------------------------------------------------
   Pieces shared by the mentor report card screens (M1-M7).

   Two rules run through all of them: a number is never shown without the
   count behind it, and nothing is conveyed by colour alone.
   --------------------------------------------------------------------------- */

const STATUS_TONE: Record<ScoreStatus, 'accent' | 'near_capacity' | 'underutilized'> = {
  final: 'accent',
  provisional: 'near_capacity',
  insufficient_data: 'underutilized',
};

export function StatusBadge({ status }: { status: ScoreStatus }): JSX.Element {
  const { glyph, text } = STATUS_LABEL[status];
  return (
    <Badge tone={STATUS_TONE[status]}>
      <span aria-hidden="true">{glyph}</span>
      {text}
    </Badge>
  );
}

/** Change since the previous period. Neutral wording in both directions. */
export function DeltaChip({ delta, label = 'since last period' }: { delta: number | null; label?: string }): JSX.Element | null {
  const described = describeDelta(delta);
  if (!described) return null;
  return (
    <span className={`delta delta--${described.direction}`}>
      <span aria-hidden="true">{described.glyph}</span> {described.text}
      {described.direction !== 'flat' && <span className="delta__label"> {label}</span>}
    </span>
  );
}

/** A score, or the reason there is none. */
export function ScoreFigure({
  value,
  status,
  size = 'lg',
  label,
}: {
  value: number | null;
  status: ScoreStatus;
  size?: 'lg' | 'md';
  label: string;
}): JSX.Element {
  if (value === null || status === 'insufficient_data') {
    return (
      <p className={`score score--${size} score--none`} aria-label={`${label}: not available`}>
        <span className="score__value">—</span>
      </p>
    );
  }
  return (
    <p className={`score score--${size}`} aria-label={`${label}: ${value} out of 100`}>
      <span className="score__value">{value}</span>
      <span className="score__scale" aria-hidden="true">
        /100
      </span>
    </p>
  );
}

/**
 * One metric with its working shown: "13 of 15 visits", a bar and the
 * percentage. Reliability metrics count confirmed issues in the numerator, so
 * they get their own phrasing.
 */
export function MetricRow({ metric, children }: { metric: MentorMetric; children?: ReactNode }): JSX.Element {
  const copy = METRIC_COPY[metric.code];
  const isReliability = metric.code.endsWith('_reliability');
  const percent = metric.value === null ? null : Math.round(metric.value);

  return (
    <div className="metric-row">
      <div className="row row--between row--wrap">
        <h3 className="metric-row__title">{copy.title}</h3>
        {metric.applicable ? (
          <span className="metric-row__value">{percent}%</span>
        ) : (
          <Badge tone="underutilized">
            <span aria-hidden="true">○</span>Not applicable
          </Badge>
        )}
      </div>
      <p className="muted metric-row__plain">{copy.plain}</p>

      {metric.applicable ? (
        <>
          <div
            className="metric-row__bar"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? 0}
            aria-label={`${copy.title} ${percent}%`}
          >
            <div className="metric-row__fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="metric-row__working">
            {isReliability ? (
              <>
                <strong>{formatCount(metric.numerator)}</strong> confirmed {metric.numerator === 1 ? 'issue' : 'issues'} in{' '}
                <strong>{formatCount(metric.denominator)}</strong> {copy.unit}
              </>
            ) : (
              <>
                <strong>{formatCount(metric.numerator)}</strong> of <strong>{formatCount(metric.denominator)}</strong>{' '}
                {copy.unit}
              </>
            )}
          </p>
        </>
      ) : (
        <p className="metric-row__working">
          Nothing in this period needed to be measured here, so it is left out and does not lower your score.
        </p>
      )}
      {children}
    </div>
  );
}

/** Sub-navigation across the report card screens for one period. */
export function ReportCardTabs({ periodId }: { periodId: string }): JSX.Element {
  const base = `/mentor/${periodId}`;
  const tabs: [string, string, boolean?][] = [
    [base, 'Overview', true],
    [`${base}/compliance`, 'Compliance'],
    [`${base}/reliability`, 'Data reliability'],
    [`${base}/records`, 'Flags & reviews'],
    [`${base}/feedback`, 'Suggestions'],
    ['/mentor/history', 'History'],
  ];
  return (
    <nav className="tabs" aria-label="Report card sections">
      {tabs.map(([to, label, end]) => (
        <NavLink key={to} to={to} end={end} className={({ isActive }) => `tabs__tab${isActive ? ' tabs__tab--active' : ''}`}>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

/** M1.6: shown whenever a closed score was recalculated after review. */
export function UpdatedNotice({ card }: { card: ReportCard }): JSX.Element | null {
  if (!card.updated) return null;
  return (
    <div className="notice" role="note">
      <strong>Updated</strong> on {formatDay(card.updated.at)}
      {card.updated.reason ? ` — ${card.updated.reason}` : ''}.
    </div>
  );
}

export function StatusNotice({ card }: { card: ReportCard }): JSX.Element | null {
  const reasons = describeStatusReasons(card.statusReasons);
  if (card.status === 'final' && !card.underReview) return null;
  return (
    <div className="notice" role="note">
      {card.status !== 'final' && (
        <>
          <p>
            <strong>{STATUS_LABEL[card.status].text}.</strong> {STATUS_EXPLAINER[card.status]}
          </p>
          {reasons.map((reason) => (
            <p key={reason} className="muted">
              {reason}
            </p>
          ))}
        </>
      )}
      {card.underReview && (
        <p>
          Some records were still under review when this period closed. This score uses confirmed issues only, and may be
          updated if a review concludes.
        </p>
      )}
    </div>
  );
}

/**
 * Loads the card for the route's period (or the latest one) and renders the
 * loading, "not ready yet" and error states, so each screen only handles the
 * case where a card exists.
 */
export function ReportCardFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: (card: ReportCard) => string;
  children: (card: ReportCard) => ReactNode;
}): JSX.Element {
  const { periodId } = useParams();
  const { data, isPending, error, notReady, refetch } = useReportCard(periodId);

  if (isPending) return <LoadingBlock rows={5} label="Loading your report card" />;
  if (notReady) {
    return (
      <>
        <PageHeader title={title} />
        <NoReportCard />
      </>
    );
  }
  if (error || !data) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle ? subtitle(data) : formatPeriod(data.period.startDate, data.period.endDate)}
        actions={<StatusBadge status={data.status} />}
      />
      <ReportCardTabs periodId={data.period.id} />
      <UpdatedNotice card={data} />
      <div className="stack">{children(data)}</div>
    </>
  );
}

export function NoReportCard(): JSX.Element {
  return (
    <Card>
      <EmptyState
        icon="◔"
        title="No report card yet"
        description="Your first report card appears after a scoring period has closed and been published. Nothing is wrong — there is simply nothing to show yet."
      />
    </Card>
  );
}

export function Definitions({ text }: { text: string }): JSX.Element {
  return (
    <details className="definitions">
      <summary>What does this score measure?</summary>
      <p>{text}</p>
      <p className="muted">
        It looks at how many valid visits you completed and how reliable the recorded data was. Recording what you truly
        observe — including things that need improvement — never lowers it.
      </p>
    </details>
  );
}
