import { Link } from 'react-router-dom';
import { useEvidence, type Evidence, type EvidenceFlag, type MentorMetric } from '../../api/mentor';
import { Card, ErrorBlock, LoadingBlock } from '../../components/ui';
import { MetricRow, ReportCardFrame, ScoreFigure } from '../../components/mentor/parts';
import { VisitList } from '../../components/mentor/VisitList';
import { FLAG_STATUS_COPY, formatVisitTime } from '../../components/mentor/format';

/** M4: reliability of recorded data, with flags kept apart from confirmed issues. */
export function ReliabilityDetailPage(): JSX.Element {
  return (
    <ReportCardFrame title="Data reliability">
      {(card) => (
        <Body
          periodId={card.period.id}
          reliability={card.reliability}
          status={card.status}
          metrics={card.metrics.filter((metric) => metric.code.endsWith('_reliability'))}
        />
      )}
    </ReportCardFrame>
  );
}

const KIND_OF: Record<string, 'inflation' | 'contradiction'> = {
  inflation_reliability: 'inflation',
  contradiction_reliability: 'contradiction',
};

function Body({
  periodId,
  reliability,
  status,
  metrics,
}: {
  periodId: string;
  reliability: number | null;
  status: 'final' | 'provisional' | 'insufficient_data';
  metrics: MentorMetric[];
}): JSX.Element {
  const evidence = useEvidence(periodId);

  return (
    <>
      <Card>
        <p className="metric__label">Data reliability score</p>
        <ScoreFigure value={reliability} status={status} label="Data reliability score" />
        <p className="muted">
          Only issues confirmed after review lower this score. A flagged record is a question, not a finding, and
          honestly recording a weak result never counts against you.
        </p>
      </Card>

      {evidence.isPending && <LoadingBlock rows={4} label="Loading your records" />}
      {evidence.error && <ErrorBlock error={evidence.error} onRetry={() => void evidence.refetch()} />}

      {metrics.map((metric) => (
        <Card key={metric.code}>
          <MetricRow metric={metric}>
            {evidence.data && <MetricDetail metric={metric} evidence={evidence.data} periodId={periodId} />}
          </MetricRow>
        </Card>
      ))}
    </>
  );
}

function MetricDetail({ metric, evidence, periodId }: { metric: MentorMetric; evidence: Evidence; periodId: string }): JSX.Element {
  const kind = KIND_OF[metric.code]!;
  const flags = evidence.flags.filter((flag) => flag.kind === kind);
  const confirmed = flags.filter((flag) => flag.status === 'confirmed').length;
  const underReview = flags.filter((flag) => ['new', 'in_review', 'escalated'].includes(flag.status)).length;
  const dismissed = flags.filter((flag) => flag.status === 'dismissed').length;
  const visits = evidence.visits.filter((visit) => visit.counted);

  return (
    <>
      <dl className="flag-counts" aria-label="Flag status">
        <div>
          <dt>Flagged, under review</dt>
          <dd>{underReview}</dd>
        </div>
        <div>
          <dt>Confirmed issues</dt>
          <dd>{confirmed}</dd>
        </div>
        <div>
          <dt>Dismissed</dt>
          <dd>{dismissed}</dd>
        </div>
      </dl>

      {flags.length > 0 && (
        <div className="stack" style={{ gap: 'var(--space-2)' }}>
          <h4 className="metric-row__subtitle">Why records were flagged</h4>
          {flags.map((flag) => (
            <FlagLine key={flag.id} flag={flag} evidence={evidence} periodId={periodId} />
          ))}
        </div>
      )}

      <VisitList
        visits={visits}
        mode={kind === 'inflation' ? 'inflation' : 'consistency'}
        label="Show the checks by visit"
      />
    </>
  );
}

function FlagLine({ flag, evidence, periodId }: { flag: EvidenceFlag; evidence: Evidence; periodId: string }): JSX.Element {
  const copy = FLAG_STATUS_COPY[flag.status];
  const visit = evidence.visits.find((entry) => entry.id === flag.visitId);
  return (
    <div className="flag-line">
      <p className="flag-line__status">
        <span aria-hidden="true">{copy.glyph}</span> {copy.label}
      </p>
      <p>{flag.why}</p>
      {visit && (
        <p className="tiny">
          Visit to {visit.schoolId} · {formatVisitTime(visit.startedAt)} ·{' '}
          <Link to={`/mentor/${periodId}/records#flag-${flag.id}`}>Open this record</Link>
        </p>
      )}
    </div>
  );
}
