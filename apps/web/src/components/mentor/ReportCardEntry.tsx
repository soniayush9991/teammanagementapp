import { Link } from 'react-router-dom';
import { useReportCard } from '../../api/mentor';
import { Card } from '../ui';
import { DeltaChip, ScoreFigure, StatusBadge } from './parts';
import { STATUS_EXPLAINER, describeStatusReasons, formatDay, formatPeriod } from './format';

/**
 * M1: the entry point on the home screen. It renders nothing for someone with
 * no published report card (not a mentor, or no period published yet), so it
 * never shows an empty or alarming placeholder.
 */
export function ReportCardEntry(): JSX.Element | null {
  const { data: card } = useReportCard();
  if (!card) return null;

  const hasScore = card.overall !== null && card.status !== 'insufficient_data';
  const reasons = describeStatusReasons(card.statusReasons);

  return (
    <Card
      title="Mentor report card"
      actions={
        <Link className="btn btn--secondary btn--sm" to="/mentor">
          View report card
        </Link>
      }
    >
      <div className="entry">
        <div>
          <p className="tiny">{formatPeriod(card.period.startDate, card.period.endDate)}</p>
          <ScoreFigure value={card.overall} status={card.status} size="md" label="Overall score" />
          <div className="row row--wrap" style={{ marginTop: 'var(--space-1)' }}>
            <StatusBadge status={card.status} />
            {hasScore && <DeltaChip delta={card.delta} label="vs last period" />}
          </div>
        </div>

        <div className="entry__side">
          {hasScore && card.previousOverall !== null && (
            <p className="muted">Previous period: {card.previousOverall}</p>
          )}
          {!hasScore && (
            <>
              <p>{STATUS_EXPLAINER[card.status]}</p>
              {reasons.map((reason) => (
                <p key={reason} className="muted">
                  {reason}
                </p>
              ))}
            </>
          )}
          {hasScore && card.status === 'provisional' && <p className="muted">{STATUS_EXPLAINER.provisional}</p>}
          {card.updated && (
            <p className="entry__updated">
              <strong>Updated</strong> on {formatDay(card.updated.at)}
              {card.updated.reason ? ` — ${card.updated.reason}` : ''}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
