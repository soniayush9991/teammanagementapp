import { Link } from 'react-router-dom';
import { useEvidence, type Evidence, type MentorMetric } from '../../api/mentor';
import { Card, ErrorBlock, LoadingBlock } from '../../components/ui';
import { MetricRow, ReportCardFrame, ScoreFigure } from '../../components/mentor/parts';
import { VisitList, type VisitListMode } from '../../components/mentor/VisitList';
import { formatCount } from '../../components/mentor/format';

const MODE: Record<string, VisitListMode> = {
  visit_coverage: 'coverage',
  duration_validity: 'duration',
  spot_completion: 'spot',
};

const LABEL: Record<string, string> = {
  visit_coverage: 'Show the visits that were counted',
  duration_validity: 'Show how long each counted visit lasted',
  spot_completion: 'Show spot assessments by visit',
};

/** M3: the three compliance measures, each with its working and its visits. */
export function ComplianceDetailPage(): JSX.Element {
  return (
    <ReportCardFrame title="Compliance">
      {(card) => <Body periodId={card.period.id} compliance={card.compliance} status={card.status} metrics={card.metrics} />}
    </ReportCardFrame>
  );
}

function Body({
  periodId,
  compliance,
  status,
  metrics,
}: {
  periodId: string;
  compliance: number | null;
  status: 'final' | 'provisional' | 'insufficient_data';
  metrics: MentorMetric[];
}): JSX.Element {
  const evidence = useEvidence(periodId);
  const rows = metrics.filter((metric) => !metric.code.endsWith('_reliability'));

  return (
    <>
      <Card>
        <p className="metric__label">Compliance score</p>
        <ScoreFigure value={compliance} status={status} label="Compliance score" />
        <p className="muted">
          Made up of visit coverage, visit duration and spot assessments. Measures that did not apply this period are left
          out, and the rest share the weight.
        </p>
      </Card>

      {evidence.isPending && <LoadingBlock rows={4} label="Loading the visits behind your score" />}
      {evidence.error && <ErrorBlock error={evidence.error} onRetry={() => void evidence.refetch()} />}

      {rows.map((metric) => (
        <Card key={metric.code}>
          <MetricRow metric={metric}>
            {evidence.data && <MetricVisits metric={metric} evidence={evidence.data} />}
          </MetricRow>
        </Card>
      ))}

      {evidence.data && <Exclusions evidence={evidence.data} periodId={periodId} />}
    </>
  );
}

function MetricVisits({ metric, evidence }: { metric: MentorMetric; evidence: Evidence }): JSX.Element | null {
  const counted = evidence.visits.filter((visit) => visit.counted);
  const visits = metric.code === 'spot_completion' ? counted.filter((visit) => visit.spotApplicable > 0) : counted;
  return <VisitList visits={visits} mode={MODE[metric.code] ?? 'coverage'} label={LABEL[metric.code] ?? 'Show visits'} />;
}

/** Exclusions are explained at a high level only (PRD M3). */
function Exclusions({ evidence, periodId }: { evidence: Evidence; periodId: string }): JSX.Element {
  const { activeDays, excludedDays } = evidence.exclusions;
  const notCounted = evidence.visits.filter((visit) => !visit.counted);

  return (
    <Card title="What was left out">
      {excludedDays !== null && excludedDays > 0 && activeDays !== null ? (
        <p>
          {formatCount(excludedDays)} of your {formatCount(activeDays)} working days were removed from the visits
          expected of you — approved leave, training or a declared system outage.
        </p>
      ) : (
        <p>No days were removed from the visits expected of you.</p>
      )}
      <p className="muted">{evidence.exclusions.note}</p>

      {notCounted.length > 0 && (
        <details className="visit-list" style={{ marginTop: 'var(--space-3)' }}>
          <summary>{notCounted.length} {notCounted.length === 1 ? 'record' : 'records'} could not be counted</summary>
          <ul className="visit-list__items">
            {notCounted.map((visit) => (
              <li key={visit.id} className="visit-list__item">
                <span className="visit-list__school">{visit.schoolId}</span>
                <span className="muted" style={{ gridColumn: 'span 2' }}>{visit.reasons.join('; ')}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="tiny" style={{ marginTop: 'var(--space-3)' }}>
        Think a record was left out by mistake? Tell your block coordinator.{' '}
        <Link to={`/mentor/${periodId}/records`}>See flags and reviews</Link>
      </p>
    </Card>
  );
}
