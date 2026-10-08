import type { MetricCode, ScoreStatus } from '../../api/mentor';

/*
 * All mentor-facing wording lives here, not in the screens, so the Hindi
 * translation (PRD §14) is a matter of swapping this module's strings rather
 * than hunting through components.
 */

const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dateYearFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dateTimeFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

const asUtc = (isoDate: string): Date => new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);

/** "5 Jan – 18 Jan 2026" from two YYYY-MM-DD strings. */
export function formatPeriod(startDate: string, endDate: string): string {
  return `${dateFormat.format(asUtc(startDate))} – ${dateYearFormat.format(asUtc(endDate))}`;
}

export function formatDay(isoDate: string): string {
  return dateYearFormat.format(asUtc(isoDate));
}

export function formatVisitTime(iso: string): string {
  return dateTimeFormat.format(new Date(iso));
}

/** Whole numbers stay whole; prorated expectations keep up to two decimals. */
export function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

export function formatPoints(value: number | null): string {
  return value === null ? '—' : String(value);
}

/** "+7", "−3", "No change". Never colour-only, never alarming. */
export function describeDelta(delta: number | null): { glyph: string; text: string; direction: 'up' | 'down' | 'flat' } | null {
  if (delta === null) return null;
  if (delta > 0) return { glyph: '▲', text: `+${delta}`, direction: 'up' };
  if (delta < 0) return { glyph: '▼', text: `−${Math.abs(delta)}`, direction: 'down' };
  return { glyph: '■', text: 'No change', direction: 'flat' };
}

export const STATUS_LABEL: Record<ScoreStatus, { glyph: string; text: string }> = {
  final: { glyph: '●', text: 'Final' },
  provisional: { glyph: '◐', text: 'Provisional' },
  insufficient_data: { glyph: '○', text: 'Insufficient data' },
};

const STATUS_REASON: Record<string, string> = {
  no_eligible_visits: 'No completed visits could be counted in this period.',
  no_quality_checks: 'There were not enough observation checks to assess data reliability.',
  below_minimum_visits: 'There were fewer counted visits than the minimum needed for a final score.',
  below_minimum_checks: 'There were fewer observation checks than the minimum needed for a final score.',
};

export function describeStatusReasons(reasons: string[]): string[] {
  return reasons.map((reason) => STATUS_REASON[reason] ?? 'There is not yet enough evidence for a final score.');
}

export const STATUS_EXPLAINER: Record<ScoreStatus, string> = {
  final: 'Calculated from enough counted visits and checks.',
  provisional: 'A score is shown, but it is based on limited evidence and may change as more is recorded.',
  insufficient_data: 'No score is shown because there was not enough evidence. This is not a low score.',
};

export const METRIC_COPY: Record<MetricCode, { title: string; plain: string; unit: string }> = {
  visit_coverage: {
    title: 'Visit coverage',
    plain: 'Counted visits compared with the visits expected of you, after leave, training and system outages.',
    unit: 'visits',
  },
  duration_validity: {
    title: 'Visit duration',
    plain: 'Counted visits that lasted long enough to be a full mentoring interaction.',
    unit: 'visits',
  },
  spot_completion: {
    title: 'Spot assessments',
    plain: 'Spot assessments completed on the visits where one was needed. Other visits are not counted here.',
    unit: 'assessments',
  },
  inflation_reliability: {
    title: 'Accuracy of observations',
    plain: 'Observations that were not confirmed, after review, as differing from what was verified.',
    unit: 'checks',
  },
  contradiction_reliability: {
    title: 'Consistency of answers',
    plain: 'Answers that were not confirmed, after review, as contradicting related answers.',
    unit: 'checks',
  },
};

export const FLAG_KIND_LABEL: Record<'inflation' | 'contradiction', string> = {
  inflation: 'Accuracy of observations',
  contradiction: 'Consistency of answers',
};

/** The exact wording from PRD screen M5, plus the in-review states. */
export const FLAG_STATUS_COPY: Record<
  'new' | 'in_review' | 'escalated' | 'confirmed' | 'dismissed',
  { glyph: string; label: string; message: string }
> = {
  new: { glyph: '◐', label: 'Flagged', message: 'This record needs review. A flag does not automatically reduce your score.' },
  in_review: { glyph: '◐', label: 'Under review', message: 'This record is being reviewed. A flag does not automatically reduce your score.' },
  escalated: { glyph: '◐', label: 'Under review', message: 'This record is being reviewed. A flag does not automatically reduce your score.' },
  confirmed: { glyph: '■', label: 'Confirmed issue', message: 'A data-integrity issue was confirmed in this record and affected the score.' },
  dismissed: { glyph: '○', label: 'Dismissed', message: 'This flag was reviewed and dismissed. It does not affect your score.' },
};

export const VISIT_REASON_FALLBACK = 'This record could not be counted.';
