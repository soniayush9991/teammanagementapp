import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useEvidence, type Evidence, type EvidenceFlag } from '../../api/mentor';
import { Card, EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui';
import { ReportCardFrame } from '../../components/mentor/parts';
import { FLAG_KIND_LABEL, FLAG_STATUS_COPY, formatVisitTime } from '../../components/mentor/format';

/** M5: every flag for the period, with what it means for the score. */
export function FlagsPage(): JSX.Element {
  return (
    <ReportCardFrame title="Flags & reviews">{(card) => <Body periodId={card.period.id} />}</ReportCardFrame>
  );
}

const GROUPS: { title: string; statuses: EvidenceFlag['status'][]; hint: string }[] = [
  { title: 'Confirmed issues', statuses: ['confirmed'], hint: 'These affected your score.' },
  { title: 'Under review', statuses: ['new', 'in_review', 'escalated'], hint: 'These have not affected your score.' },
  { title: 'Dismissed', statuses: ['dismissed'], hint: 'These were reviewed and have no effect.' },
];

function Body({ periodId }: { periodId: string }): JSX.Element {
  const { data, isPending, error, refetch } = useEvidence(periodId);
  const location = useLocation();

  // Deep links from the reliability screen ("Open this record") land on the flag.
  useEffect(() => {
    if (!data || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' });
  }, [data, location.hash]);

  if (isPending) return <LoadingBlock rows={4} label="Loading your flags" />;
  if (error || !data) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  if (data.flags.length === 0) {
    return (
      <Card>
        <EmptyState icon="●" title="No data-integrity issues confirmed for this period." description="Nothing was flagged for review." />
      </Card>
    );
  }

  return (
    <>
      <div className="notice" role="note">
        Some records needed review. A flag does not automatically reduce your score — only an issue confirmed after review
        does.
      </div>
      {GROUPS.map((group) => {
        const flags = data.flags.filter((flag) => group.statuses.includes(flag.status));
        if (flags.length === 0) return null;
        return (
          <Card key={group.title} title={group.title}>
            <p className="muted" style={{ marginBottom: 'var(--space-3)' }}>
              {group.hint}
            </p>
            <div className="stack">
              {flags.map((flag) => (
                <FlagCard key={flag.id} flag={flag} evidence={data} />
              ))}
            </div>
          </Card>
        );
      })}
    </>
  );
}

function FlagCard({ flag, evidence }: { flag: EvidenceFlag; evidence: Evidence }): JSX.Element {
  const copy = FLAG_STATUS_COPY[flag.status];
  const visit = evidence.visits.find((entry) => entry.id === flag.visitId);
  return (
    <article className="flag-card" id={`flag-${flag.id}`} tabIndex={-1}>
      <header className="row row--between row--wrap">
        <h3 className="metric-row__title">{FLAG_KIND_LABEL[flag.kind]}</h3>
        <span className="flag-line__status">
          <span aria-hidden="true">{copy.glyph}</span> {copy.label}
        </span>
      </header>
      <p>{flag.why}</p>
      {visit && (
        <p className="tiny">
          Visit to {visit.schoolId} · {formatVisitTime(visit.startedAt)}
        </p>
      )}
      <p className="flag-card__message">{copy.message}</p>
      {flag.resolvedAt && <p className="tiny">Reviewed {formatVisitTime(flag.resolvedAt)}</p>}
    </article>
  );
}
