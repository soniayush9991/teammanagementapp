import { Link } from 'react-router-dom';
import type { ReportCard, TrendPoint } from '../../api/mentor';
import { Card } from '../../components/ui';
import { Definitions, DeltaChip, ReportCardFrame, ScoreFigure, StatusBadge, StatusNotice } from '../../components/mentor/parts';
import { STATUS_LABEL, formatPeriod } from '../../components/mentor/format';

/** M2: the whole report card on one screen, with a way into each part. */
export function ReportCardPage(): JSX.Element {
  return (
    <ReportCardFrame title="Your report card">
      {(card) => (
        <>
          <Hero card={card} />
          <StatusNotice card={card} />
          <div className="grid grid--halves">
            <ComponentCard
              title="Compliance"
              blurb="Valid visits, visit duration and spot assessments."
              value={card.compliance}
              card={card}
              to={`/mentor/${card.period.id}/compliance`}
            />
            <ComponentCard
              title="Data reliability"
              blurb="How reliable the recorded observations were after review."
              value={card.reliability}
              card={card}
              to={`/mentor/${card.period.id}/reliability`}
            />
          </div>
          <div className="grid grid--halves">
            <TrendCard card={card} />
            <ContextCard card={card} />
          </div>
          <ActionCard card={card} />
          <Definitions text={card.definitions} />
        </>
      )}
    </ReportCardFrame>
  );
}

function Hero({ card }: { card: ReportCard }): JSX.Element {
  const hasScore = card.overall !== null && card.status !== 'insufficient_data';
  return (
    <Card>
      <div className="hero">
        <div>
          <p className="metric__label">Overall score · {formatPeriod(card.period.startDate, card.period.endDate)}</p>
          <ScoreFigure value={card.overall} status={card.status} label="Overall score" />
        </div>
        <div className="stack" style={{ gap: 'var(--space-2)' }}>
          <StatusBadge status={card.status} />
          {hasScore && <DeltaChip delta={card.delta} />}
          {hasScore && card.previousOverall !== null && <span className="muted">Previous period: {card.previousOverall}</span>}
        </div>
      </div>
    </Card>
  );
}

function ComponentCard({
  title,
  blurb,
  value,
  card,
  to,
}: {
  title: string;
  blurb: string;
  value: number | null;
  card: ReportCard;
  to: string;
}): JSX.Element {
  return (
    <Card
      title={title}
      actions={
        <Link className="btn btn--ghost btn--sm" to={to}>
          See details
        </Link>
      }
    >
      <ScoreFigure value={value} status={card.status} size="md" label={`${title} score`} />
      <p className="muted">{blurb}</p>
    </Card>
  );
}

/** Last three completed periods, oldest first, as a trend — not a ranking. */
function TrendCard({ card }: { card: ReportCard }): JSX.Element {
  const points: TrendPoint[] = [...card.trend].slice(0, 3).reverse();
  const scored = points.filter((point) => point.overall !== null);

  return (
    <Card title="Your trend" actions={<Link className="btn btn--ghost btn--sm" to="/mentor/history">All periods</Link>}>
      {scored.length < 2 ? (
        <p className="muted">Your trend appears once you have two scored periods.</p>
      ) : (
        <ol className="trend">
          {points.map((point) => (
            <li key={point.periodId} className="trend__row">
              <span className="trend__label">{formatPeriod(point.startDate, point.endDate)}</span>
              {point.overall === null ? (
                <span className="muted">{STATUS_LABEL[point.status].text}</span>
              ) : (
                <>
                  <span className="trend__bar" aria-hidden="true">
                    <span className="trend__fill" style={{ width: `${point.overall}%` }} />
                  </span>
                  <span className="trend__value">
                    {point.overall}
                    {point.periodId === card.period.id && <span className="tiny"> (this period)</span>}
                  </span>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function ContextCard({ card }: { card: ReportCard }): JSX.Element {
  const benchmark = card.benchmark;
  return (
    <Card title="For context">
      <dl className="facts">
        <div>
          <dt>Your previous period</dt>
          <dd>{card.previousOverall ?? 'Not available'}</dd>
        </div>
        <div>
          <dt>{benchmark?.label ?? 'District median'}</dt>
          <dd>
            {benchmark && !benchmark.suppressed && benchmark.value !== null
              ? Math.round(benchmark.value)
              : 'Not shown'}
          </dd>
        </div>
      </dl>
      {benchmark?.suppressed && (
        <p className="tiny">The median is hidden when too few mentors are in the group to compare fairly.</p>
      )}
      <p className="tiny">
        These are for context only. A difference from the median is not a target, and does not show what caused it.
      </p>
    </Card>
  );
}

function ActionCard({ card }: { card: ReportCard }): JSX.Element | null {
  if (card.status === 'insufficient_data') return null;
  return (
    <Card title="One thing to focus on">
      {card.primaryAction ? (
        <p>{card.primaryAction.message}</p>
      ) : (
        <p>Nothing needs changing right now. Keep recording what you observe, as it is.</p>
      )}
      <p style={{ marginTop: 'var(--space-3)' }}>
        <Link to={`/mentor/${card.period.id}/feedback`}>See all suggestions</Link>
      </p>
    </Card>
  );
}
