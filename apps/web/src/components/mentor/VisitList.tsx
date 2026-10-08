import type { EvidenceVisit } from '../../api/mentor';
import { formatVisitTime } from './format';

export type VisitListMode = 'coverage' | 'duration' | 'spot' | 'inflation' | 'consistency';

function detail(visit: EvidenceVisit, mode: VisitListMode): string {
  switch (mode) {
    case 'duration': {
      const minutes = visit.durationMinutes === null ? null : Math.round(visit.durationMinutes);
      if (minutes === null) return 'Duration unavailable';
      return visit.durationValid ? `${minutes} min · long enough` : `${minutes} min · shorter than the minimum`;
    }
    case 'spot':
      return `${visit.spotCompleted} of ${visit.spotApplicable} completed`;
    case 'inflation':
      return `${visit.inflationChecks} ${visit.inflationChecks === 1 ? 'check' : 'checks'}`;
    case 'consistency':
      return `${visit.consistencyChecks} ${visit.consistencyChecks === 1 ? 'check' : 'checks'}`;
    default:
      return 'Counted';
  }
}

/**
 * The visits behind one number, tucked behind a disclosure so the screen
 * stays calm until a mentor wants the evidence.
 */
export function VisitList({ visits, mode, label }: { visits: EvidenceVisit[]; mode: VisitListMode; label: string }): JSX.Element | null {
  if (visits.length === 0) return null;
  return (
    <details className="visit-list">
      <summary>
        {label} ({visits.length})
      </summary>
      <ul className="visit-list__items">
        {visits.map((visit) => (
          <li key={visit.id} className="visit-list__item">
            <span className="visit-list__school">{visit.schoolId}</span>
            <span className="muted">{formatVisitTime(visit.startedAt)}</span>
            <span>{detail(visit, mode)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
