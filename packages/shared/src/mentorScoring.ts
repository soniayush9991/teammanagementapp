/**
 * Mentor scoring engine.
 *
 * Pure and deterministic: the same evidence and the same configuration always
 * produce the same score, which is what lets the API freeze a closed period
 * and later explain every number on a report card. Nothing here reads the
 * clock, the database or a mutable global.
 *
 * Shape of the score (defaults from the PRD):
 *   overall     = 0.40 * compliance  + 0.60 * reliability
 *   compliance  = 0.60 * coverage    + 0.20 * duration  + 0.20 * spot
 *   reliability = 0.50 * inflation   + 0.50 * contradiction
 * A metric with nothing to measure is "not applicable": it drops out of its
 * component and the remaining weights are rescaled, never scored as zero.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const SCORE_METRIC_CODES = [
  'visit_coverage',
  'duration_validity',
  'spot_completion',
  'inflation_reliability',
  'contradiction_reliability',
] as const;
export type ScoreMetricCode = (typeof SCORE_METRIC_CODES)[number];

export type ScoreComponent = 'compliance' | 'reliability';

export const METRIC_COMPONENT: Record<ScoreMetricCode, ScoreComponent> = {
  visit_coverage: 'compliance',
  duration_validity: 'compliance',
  spot_completion: 'compliance',
  inflation_reliability: 'reliability',
  contradiction_reliability: 'reliability',
};

export type LateConfirmationPolicy = 'carryover' | 'recalculate';

export interface MentorScoreConfig {
  /** Period length in calendar days. Boundaries are fixed once published. */
  periodDays: number;
  componentWeights: Record<ScoreComponent, number>;
  complianceWeights: Record<'visit_coverage' | 'duration_validity' | 'spot_completion', number>;
  reliabilityWeights: Record<'inflation_reliability' | 'contradiction_reliability', number>;
  minValidDurationMinutes: number;
  durationCapMinutes: number;
  /** A mentor is Provisional until both minimums are met. */
  minEvidence: { eligibleVisits: number; qualityChecks: number };
  /** Reliability score a mentor needs to qualify for any recognition. */
  recognitionQualityFloor: number;
  /** Benchmarks are suppressed below this many mentors. */
  benchmarkMinCohort: number;
  /** What happens to a flag confirmed after its period closed. */
  lateConfirmationPolicy: LateConfirmationPolicy;
  /** Expected visits per full period, keyed by mentor role. */
  roleTargets: Record<string, number>;
  defaultRoleTarget: number;
  /** When false, an unverified location is accepted (offline-first rollout). */
  requireVerifiedLocation: boolean;
  /** Two visits to one school starting this close together are duplicates. */
  duplicateWindowMinutes: number;
}

export const DEFAULT_SCORE_CONFIG: MentorScoreConfig = {
  periodDays: 14,
  componentWeights: { compliance: 0.4, reliability: 0.6 },
  complianceWeights: { visit_coverage: 0.6, duration_validity: 0.2, spot_completion: 0.2 },
  reliabilityWeights: { inflation_reliability: 0.5, contradiction_reliability: 0.5 },
  minValidDurationMinutes: 30,
  durationCapMinutes: 60,
  minEvidence: { eligibleVisits: 5, qualityChecks: 20 },
  recognitionQualityFloor: 80,
  benchmarkMinCohort: 5,
  lateConfirmationPolicy: 'carryover',
  roleTargets: {},
  defaultRoleTarget: 15,
  requireVerifiedLocation: true,
  duplicateWindowMinutes: 120,
};

const WEIGHT_EPSILON = 1e-6;

/** Returns human-readable problems; an empty list means the config is publishable. */
export function validateScoreConfig(config: MentorScoreConfig): string[] {
  const problems: string[] = [];
  const sums: [string, number][] = [
    ['componentWeights', sumValues(config.componentWeights)],
    ['complianceWeights', sumValues(config.complianceWeights)],
    ['reliabilityWeights', sumValues(config.reliabilityWeights)],
  ];
  for (const [name, sum] of sums) {
    if (Math.abs(sum - 1) > WEIGHT_EPSILON) problems.push(`${name} must sum to 100% (got ${round2(sum * 100)}%)`);
  }
  const allWeights = [
    ...Object.values(config.componentWeights),
    ...Object.values(config.complianceWeights),
    ...Object.values(config.reliabilityWeights),
  ];
  if (allWeights.some((weight) => !Number.isFinite(weight) || weight < 0)) {
    problems.push('weights must be non-negative numbers');
  }
  if (!Number.isInteger(config.periodDays) || config.periodDays < 1) problems.push('periodDays must be a positive integer');
  if (config.minValidDurationMinutes < 0) problems.push('minValidDurationMinutes cannot be negative');
  if (config.durationCapMinutes < config.minValidDurationMinutes) {
    problems.push('durationCapMinutes must be at least minValidDurationMinutes');
  }
  if (config.minEvidence.eligibleVisits < 0 || config.minEvidence.qualityChecks < 0) {
    problems.push('minEvidence thresholds cannot be negative');
  }
  if (config.recognitionQualityFloor < 0 || config.recognitionQualityFloor > 100) {
    problems.push('recognitionQualityFloor must be between 0 and 100');
  }
  if (config.benchmarkMinCohort < 1) problems.push('benchmarkMinCohort must be at least 1');
  if (config.duplicateWindowMinutes < 0) problems.push('duplicateWindowMinutes cannot be negative');
  if (config.defaultRoleTarget < 0 || Object.values(config.roleTargets).some((target) => target < 0)) {
    problems.push('visit targets cannot be negative');
  }
  return problems;
}

function sumValues(record: Record<string, number>): number {
  return Object.values(record).reduce((total, value) => total + value, 0);
}

export function roleTarget(config: MentorScoreConfig, mentorRole: string | null | undefined): number {
  if (mentorRole && Object.prototype.hasOwnProperty.call(config.roleTargets, mentorRole)) {
    return config.roleTargets[mentorRole] as number;
  }
  return config.defaultRoleTarget;
}

// ---------------------------------------------------------------------------
// Dates and proration
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function dayNumber(isoDate: string): number {
  const parsed = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed)) throw new RangeError(`Invalid date: ${isoDate}`);
  return Math.floor(parsed / DAY_MS);
}

export interface DateRange {
  start: string;
  end: string;
}

/** Inclusive length of a date range, 0 when it is empty or inverted. */
export function rangeDays(range: DateRange): number {
  return Math.max(0, dayNumber(range.end) - dayNumber(range.start) + 1);
}

/**
 * Days of `period` during which the mentor held the assignment. Open-ended
 * activity (no start or end) is treated as active from or until the period edge.
 */
export function activeDays(period: DateRange, activeFrom: string | null, activeTo: string | null): number {
  return rangeDays(clip(period, activeFrom, activeTo));
}

function clip(period: DateRange, from: string | null, to: string | null): DateRange {
  const start = from && dayNumber(from) > dayNumber(period.start) ? from : period.start;
  const end = to && dayNumber(to) < dayNumber(period.end) ? to : period.end;
  return { start, end };
}

/**
 * Days inside the active window that are covered by at least one exclusion
 * (approved leave, training, declared outage). Overlapping exclusions are
 * merged so a day is never removed from the denominator twice.
 */
export function excludedDays(
  period: DateRange,
  activeFrom: string | null,
  activeTo: string | null,
  exclusions: readonly DateRange[],
): number {
  const window = clip(period, activeFrom, activeTo);
  if (rangeDays(window) === 0) return 0;
  const windowStart = dayNumber(window.start);
  const windowEnd = dayNumber(window.end);

  const spans = exclusions
    .map((range) => [Math.max(dayNumber(range.start), windowStart), Math.min(dayNumber(range.end), windowEnd)] as const)
    .filter(([start, end]) => start <= end)
    .sort((a, b) => a[0] - b[0]);

  let total = 0;
  let cursor = -Infinity;
  for (const [start, end] of spans) {
    const from = Math.max(start, cursor + 1);
    if (end >= from) total += end - from + 1;
    cursor = Math.max(cursor, end);
  }
  return total;
}

export interface ExpectedVisitsInput {
  target: number;
  periodDays: number;
  activeDays: number;
  excludedDays: number;
}

/** Role target prorated by the days the mentor was active and not excused. */
export function expectedVisits(input: ExpectedVisitsInput): number {
  const billable = Math.max(0, Math.min(input.activeDays, input.periodDays) - Math.max(0, input.excludedDays));
  return round2((Math.max(0, input.target) * billable) / Math.max(1, input.periodDays));
}

// ---------------------------------------------------------------------------
// Visit validation
// ---------------------------------------------------------------------------

export type LocationStatus = 'verified' | 'exception' | 'unverified' | 'failed';

export interface VisitRecord {
  id: string;
  mentorId: string;
  schoolId: string;
  startedAt: string | Date;
  endedAt: string | Date;
  submittedAt?: string | Date | null;
  completed: boolean;
  assignmentValid: boolean;
  location: LocationStatus;
  isTest?: boolean;
  isDeleted?: boolean;
  isCancelled?: boolean;
  /** Spot assessments required / actually completed for this visit. */
  spotApplicable?: number;
  spotCompleted?: number;
  /** Observation-level quality checks the rule engine could evaluate. */
  inflationChecks?: number;
  consistencyChecks?: number;
}

export const VISIT_INVALID_REASONS = [
  'invalid_assignment',
  'invalid_timestamps',
  'location_unverified',
  'incomplete',
  'duplicate',
  'system_record',
] as const;
export type VisitInvalidReason = (typeof VISIT_INVALID_REASONS)[number];

export interface VisitAssessment {
  visitId: string;
  eligible: boolean;
  reasons: VisitInvalidReason[];
  durationMinutes: number | null;
  /** Duration actually scored, capped so long sessions earn nothing extra. */
  scoredDurationMinutes: number | null;
  durationValid: boolean;
}

function toMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/**
 * Applies the PRD's validation hierarchy to one visit. Every failing check is
 * reported, not only the first, so a reviewer sees the whole picture. The
 * duplicate check needs the other visits and is applied by `assessVisits`.
 */
export function assessVisit(visit: VisitRecord, config: MentorScoreConfig): VisitAssessment {
  const reasons: VisitInvalidReason[] = [];

  if (!visit.assignmentValid) reasons.push('invalid_assignment');

  const started = toMs(visit.startedAt);
  const ended = toMs(visit.endedAt);
  const timestampsValid = Number.isFinite(started) && Number.isFinite(ended) && ended >= started;
  if (!timestampsValid) reasons.push('invalid_timestamps');

  const locationOk =
    visit.location === 'verified' ||
    visit.location === 'exception' ||
    (visit.location === 'unverified' && !config.requireVerifiedLocation);
  if (!locationOk) reasons.push('location_unverified');

  if (!visit.completed) reasons.push('incomplete');
  if (visit.isTest || visit.isDeleted || visit.isCancelled) reasons.push('system_record');

  const durationMinutes = timestampsValid ? (ended - started) / 60_000 : null;
  const scoredDurationMinutes = durationMinutes === null ? null : Math.min(durationMinutes, config.durationCapMinutes);
  const eligible = reasons.length === 0;

  return {
    visitId: visit.id,
    eligible,
    reasons,
    durationMinutes,
    scoredDurationMinutes,
    durationValid: eligible && scoredDurationMinutes !== null && scoredDurationMinutes >= config.minValidDurationMinutes,
  };
}

export interface DuplicateVisit {
  visit: VisitRecord;
  duplicateOf: string;
}

export interface VisitEvidenceTotals {
  eligibleVisits: number;
  durationValidVisits: number;
  spotApplicable: number;
  spotCompleted: number;
  inflationChecks: number;
  consistencyChecks: number;
}

export interface AssessedVisits {
  /** One entry per distinct visit id; window duplicates are ineligible with reason `duplicate`. */
  assessments: VisitAssessment[];
  duplicates: DuplicateVisit[];
  evidence: VisitEvidenceTotals;
}

function compareVisits(a: VisitRecord, b: VisitRecord): number {
  const delta = toMs(a.startedAt) - toMs(b.startedAt);
  return delta !== 0 ? delta : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Validates and totals a mentor's visits for one period.
 *
 * Duplicates are resolved in two steps, both independent of input order:
 *  1. a repeated visit id (network retry, offline re-sync) collapses to one;
 *  2. among visits that are otherwise valid, a second visit by the same
 *     mentor to the same school starting inside the duplicate window is
 *     ineligible, keeping the earliest. Invalid visits never absorb a valid
 *     one, so an abandoned attempt cannot cost a mentor the real visit.
 * A visit contributes at most one unit of coverage, one duration result, and
 * its own clamped spot-assessment and check counts, and only when eligible.
 */
export function assessVisits(visits: readonly VisitRecord[], config: MentorScoreConfig): AssessedVisits {
  const duplicates: DuplicateVisit[] = [];

  const unique: VisitRecord[] = [];
  const seenIds = new Set<string>();
  for (const visit of [...visits].sort(compareVisits)) {
    if (seenIds.has(visit.id)) {
      duplicates.push({ visit, duplicateOf: visit.id });
      continue;
    }
    seenIds.add(visit.id);
    unique.push(visit);
  }

  const windowMs = config.duplicateWindowMinutes * 60_000;
  const lastValidBySchool = new Map<string, VisitRecord>();
  const assessments: VisitAssessment[] = [];
  const evidence: VisitEvidenceTotals = {
    eligibleVisits: 0,
    durationValidVisits: 0,
    spotApplicable: 0,
    spotCompleted: 0,
    inflationChecks: 0,
    consistencyChecks: 0,
  };

  for (const visit of unique) {
    let assessment = assessVisit(visit, config);
    if (assessment.eligible) {
      const key = `${visit.mentorId}|${visit.schoolId}`;
      const previous = lastValidBySchool.get(key);
      if (previous && toMs(visit.startedAt) - toMs(previous.startedAt) <= windowMs) {
        duplicates.push({ visit, duplicateOf: previous.id });
        assessment = { ...assessment, eligible: false, reasons: ['duplicate'], durationValid: false };
      } else {
        lastValidBySchool.set(key, visit);
      }
    }
    assessments.push(assessment);
    if (!assessment.eligible) continue;

    evidence.eligibleVisits += 1;
    if (assessment.durationValid) evidence.durationValidVisits += 1;
    const applicable = Math.max(0, visit.spotApplicable ?? 0);
    evidence.spotApplicable += applicable;
    evidence.spotCompleted += Math.min(Math.max(0, visit.spotCompleted ?? 0), applicable);
    evidence.inflationChecks += Math.max(0, visit.inflationChecks ?? 0);
    evidence.consistencyChecks += Math.max(0, visit.consistencyChecks ?? 0);
  }
  return { assessments, duplicates, evidence };
}

// ---------------------------------------------------------------------------
// Score calculation
// ---------------------------------------------------------------------------

export type ScoreStatus = 'final' | 'provisional' | 'insufficient_data';

export interface ScoreEvidence {
  expectedVisits: number;
  eligibleVisits: number;
  durationValidVisits: number;
  spotApplicable: number;
  spotCompleted: number;
  inflationChecks: number;
  confirmedInflation: number;
  consistencyChecks: number;
  confirmedContradictions: number;
  /** Flags still New / In review / Escalated; informational, never a deduction. */
  unresolvedFlags?: number;
}

export interface MetricResult {
  code: ScoreMetricCode;
  component: ScoreComponent;
  /** Reliability metrics count confirmed issues; compliance metrics count successes. */
  numerator: number;
  denominator: number;
  /** 0-100, null when not applicable. */
  rawValue: number | null;
  applicable: boolean;
  /** Configured weight inside the component. */
  weight: number;
  /** Share of the final score after rescaling, 0 when not applicable. */
  effectiveWeight: number;
  /** Points this metric contributes to the final score. */
  weightedValue: number;
}

export interface MentorScoreResult {
  status: ScoreStatus;
  /** Why the status is not Final; empty for Final. */
  statusReasons: ('no_eligible_visits' | 'no_quality_checks' | 'below_minimum_visits' | 'below_minimum_checks')[];
  overall: number | null;
  compliance: number | null;
  reliability: number | null;
  metrics: MetricResult[];
  underReview: boolean;
  evidence: ScoreEvidence;
}

/** Half-up rounding to two decimals, immune to binary-float noise like 1.005. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  // A numerator can never exceed what was eligible to be counted.
  return Math.min(Math.max(numerator, 0), denominator) / denominator;
}

export function computeMentorScore(rawEvidence: ScoreEvidence, config: MentorScoreConfig): MentorScoreResult {
  const evidence = sanitizeEvidence(rawEvidence);

  const coverage = ratio(evidence.eligibleVisits, evidence.expectedVisits);
  const duration = ratio(evidence.durationValidVisits, evidence.eligibleVisits);
  const spot = ratio(evidence.spotCompleted, evidence.spotApplicable);
  const inflation = ratio(evidence.confirmedInflation, evidence.inflationChecks);
  const contradiction = ratio(evidence.confirmedContradictions, evidence.consistencyChecks);

  const drafts: Omit<MetricResult, 'effectiveWeight' | 'weightedValue'>[] = [
    metric('visit_coverage', Math.min(evidence.eligibleVisits, evidence.expectedVisits), evidence.expectedVisits, coverage === null ? null : coverage * 100, config.complianceWeights.visit_coverage),
    metric('duration_validity', evidence.durationValidVisits, evidence.eligibleVisits, duration === null ? null : duration * 100, config.complianceWeights.duration_validity),
    metric('spot_completion', evidence.spotCompleted, evidence.spotApplicable, spot === null ? null : spot * 100, config.complianceWeights.spot_completion),
    metric('inflation_reliability', evidence.confirmedInflation, evidence.inflationChecks, inflation === null ? null : 100 - inflation * 100, config.reliabilityWeights.inflation_reliability),
    metric('contradiction_reliability', evidence.confirmedContradictions, evidence.consistencyChecks, contradiction === null ? null : 100 - contradiction * 100, config.reliabilityWeights.contradiction_reliability),
  ];

  // With no eligible visit there is nothing to score: show Insufficient data
  // rather than a zero coverage that would read as a failing mentor.
  const hasVisits = evidence.eligibleVisits > 0;
  const complianceScore = hasVisits ? componentScore(drafts, 'compliance') : null;
  const reliabilityScore = hasVisits ? componentScore(drafts, 'reliability') : null;
  const bothComponents = complianceScore !== null && reliabilityScore !== null;

  const overall = bothComponents
    ? config.componentWeights.compliance * complianceScore + config.componentWeights.reliability * reliabilityScore
    : null;

  const metrics: MetricResult[] = drafts.map((draft) => {
    const componentWeight = config.componentWeights[draft.component];
    const applicableTotal = drafts
      .filter((other) => other.component === draft.component && other.applicable)
      .reduce((total, other) => total + other.weight, 0);
    const effectiveWeight =
      bothComponents && draft.applicable && applicableTotal > 0 ? (componentWeight * draft.weight) / applicableTotal : 0;
    return {
      ...draft,
      rawValue: draft.rawValue === null ? null : round2(draft.rawValue),
      effectiveWeight: round2(effectiveWeight * 100) / 100,
      weightedValue: draft.rawValue === null ? 0 : round2(effectiveWeight * draft.rawValue),
    };
  });

  const statusReasons: MentorScoreResult['statusReasons'] = [];
  if (evidence.eligibleVisits === 0) statusReasons.push('no_eligible_visits');
  if (evidence.inflationChecks + evidence.consistencyChecks === 0) statusReasons.push('no_quality_checks');
  if (statusReasons.length === 0) {
    if (evidence.eligibleVisits < config.minEvidence.eligibleVisits) statusReasons.push('below_minimum_visits');
    if (evidence.inflationChecks + evidence.consistencyChecks < config.minEvidence.qualityChecks) {
      statusReasons.push('below_minimum_checks');
    }
  }

  const status: ScoreStatus = !bothComponents
    ? 'insufficient_data'
    : statusReasons.length > 0
      ? 'provisional'
      : 'final';

  return {
    status,
    statusReasons,
    overall: overall === null ? null : round2(overall),
    compliance: complianceScore === null ? null : round2(complianceScore),
    reliability: reliabilityScore === null ? null : round2(reliabilityScore),
    metrics,
    underReview: (evidence.unresolvedFlags ?? 0) > 0,
    evidence,
  };
}

function metric(
  code: ScoreMetricCode,
  numerator: number,
  denominator: number,
  rawValue: number | null,
  weight: number,
): Omit<MetricResult, 'effectiveWeight' | 'weightedValue'> {
  return {
    code,
    component: METRIC_COMPONENT[code],
    numerator: round2(numerator),
    denominator: round2(denominator),
    rawValue,
    applicable: rawValue !== null,
    weight,
  };
}

/** Weighted average over applicable metrics only, rescaling their weights. */
function componentScore(
  metrics: readonly Omit<MetricResult, 'effectiveWeight' | 'weightedValue'>[],
  component: ScoreComponent,
): number | null {
  const applicable = metrics.filter((entry) => entry.component === component && entry.rawValue !== null);
  const totalWeight = applicable.reduce((total, entry) => total + entry.weight, 0);
  if (applicable.length === 0 || totalWeight <= 0) return null;
  return applicable.reduce((total, entry) => total + (entry.weight * (entry.rawValue as number)) / totalWeight, 0);
}

function sanitizeEvidence(evidence: ScoreEvidence): ScoreEvidence {
  const count = (value: number | undefined): number => (Number.isFinite(value) ? Math.max(0, value as number) : 0);
  const inflationChecks = count(evidence.inflationChecks);
  const consistencyChecks = count(evidence.consistencyChecks);
  const eligibleVisits = count(evidence.eligibleVisits);
  const spotApplicable = count(evidence.spotApplicable);
  return {
    expectedVisits: count(evidence.expectedVisits),
    eligibleVisits,
    durationValidVisits: Math.min(count(evidence.durationValidVisits), eligibleVisits),
    spotApplicable,
    spotCompleted: Math.min(count(evidence.spotCompleted), spotApplicable),
    inflationChecks,
    confirmedInflation: Math.min(count(evidence.confirmedInflation), inflationChecks),
    consistencyChecks,
    confirmedContradictions: Math.min(count(evidence.confirmedContradictions), consistencyChecks),
    unresolvedFlags: count(evidence.unresolvedFlags),
  };
}

// ---------------------------------------------------------------------------
// Trend, benchmark, nudges, recognition
// ---------------------------------------------------------------------------

/** Whole-point change between two displayed scores; null if either is missing. */
export function scoreDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return Math.round(current) - Math.round(previous);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export interface BenchmarkResult {
  statistic: 'median';
  value: number | null;
  cohortSize: number;
  suppressed: boolean;
}

/**
 * Median of a cohort's scores, suppressed when the cohort is too small to
 * hide an individual. One value per mentor means no mentor can weigh more
 * than another, and a median is insensitive to a single extreme score, which
 * is the contribution cap the PRD asks for.
 */
export function benchmarkMedian(scores: readonly number[], config: MentorScoreConfig): BenchmarkResult {
  const suppressed = scores.length < config.benchmarkMinCohort;
  return {
    statistic: 'median',
    value: suppressed ? null : round2(median(scores) as number),
    cohortSize: scores.length,
    suppressed,
  };
}

export type NudgeCode =
  | 'coverage_low'
  | 'duration_low'
  | 'spot_low'
  | 'confirmed_contradiction'
  | 'confirmed_inflation'
  | 'most_improved';

export interface Nudge {
  code: NudgeCode;
  params: Record<string, number>;
  message: string;
}

const NUDGE_MESSAGES: Record<NudgeCode, (params: Record<string, number>) => string> = {
  coverage_low: (p) =>
    `You completed ${p.percent}% of your expected visits. Focus on the remaining assigned schools in the current period.`,
  duration_low: () =>
    'Several completed visits did not meet the minimum valid duration. Focus on completing the full mentoring interaction before submitting.',
  spot_low: () =>
    'Complete spot assessments for visits where they are applicable. Non-applicable visits are excluded from this metric.',
  confirmed_contradiction: () =>
    'One or more submitted observations were inconsistent with related responses. Review your entries before submission.',
  confirmed_inflation: () =>
    'One or more observations were confirmed as not matching what was verified on review. Record what you observed, including areas that need improvement.',
  most_improved: (p) => `Your score improved by ${p.points} points from the previous period.`,
};

function makeNudge(code: NudgeCode, params: Record<string, number> = {}): Nudge {
  return { code, params, message: NUDGE_MESSAGES[code](params) };
}

/**
 * Nudges tied to the specific driver that moved the score, ordered by how
 * many points each is costing. The wording is supportive by construction:
 * there is no template that mentions rank, comparison with peers, or reward
 * for positive reporting.
 */
export function selectNudges(result: MentorScoreResult, previousOverall: number | null = null): Nudge[] {
  if (result.status === 'insufficient_data') return [];
  const nudges: { nudge: Nudge; impact: number }[] = [];
  const byCode = new Map(result.metrics.map((entry) => [entry.code, entry]));

  const pointsLost = (code: ScoreMetricCode): number => {
    const entry = byCode.get(code);
    return entry && entry.rawValue !== null ? (entry.effectiveWeight * (100 - entry.rawValue)) : 0;
  };

  const coverage = byCode.get('visit_coverage');
  if (coverage?.rawValue !== null && coverage !== undefined && (coverage.rawValue as number) < 100) {
    nudges.push({ nudge: makeNudge('coverage_low', { percent: Math.round(coverage.rawValue as number) }), impact: pointsLost('visit_coverage') });
  }
  const duration = byCode.get('duration_validity');
  if (duration?.rawValue !== null && duration !== undefined && (duration.rawValue as number) < 100) {
    nudges.push({ nudge: makeNudge('duration_low'), impact: pointsLost('duration_validity') });
  }
  const spot = byCode.get('spot_completion');
  if (spot?.rawValue !== null && spot !== undefined && (spot.rawValue as number) < 100) {
    nudges.push({ nudge: makeNudge('spot_low'), impact: pointsLost('spot_completion') });
  }
  if (result.evidence.confirmedContradictions > 0) {
    nudges.push({ nudge: makeNudge('confirmed_contradiction'), impact: pointsLost('contradiction_reliability') });
  }
  if (result.evidence.confirmedInflation > 0) {
    nudges.push({ nudge: makeNudge('confirmed_inflation'), impact: pointsLost('inflation_reliability') });
  }

  nudges.sort((a, b) => b.impact - a.impact);
  const ordered = nudges.map((entry) => entry.nudge);

  const delta = scoreDelta(result.overall, previousOverall);
  if (delta !== null && delta > 0) ordered.push(makeNudge('most_improved', { points: delta }));
  return ordered;
}

/**
 * The single action to show on the report card: the nudge for whichever
 * driver is costing the most points, or null when nothing is.
 */
export function primaryAction(result: MentorScoreResult): Nudge | null {
  const nudges = selectNudges(result).filter((nudge) => nudge.code !== 'most_improved');
  return nudges[0] ?? null;
}

export const RECOGNITION_CATEGORIES = ['top_overall', 'most_improved', 'reliable_data', 'strong_coverage'] as const;
export type RecognitionCategory = (typeof RECOGNITION_CATEGORIES)[number];

export interface RecognitionCandidate {
  mentorId: string;
  status: ScoreStatus;
  overall: number | null;
  compliance: number | null;
  reliability: number | null;
  underReview: boolean;
  /** Overall score of the previous comparable (final) period, if any. */
  previousOverall: number | null;
}

/**
 * Whether a mentor may be recognised at all. Recognition rewards trustworthy
 * data, so it needs a Final score, the reliability floor, and no open
 * integrity question on the record.
 */
export function isRecognitionEligible(candidate: RecognitionCandidate, config: MentorScoreConfig): boolean {
  return (
    candidate.status === 'final' &&
    !candidate.underReview &&
    candidate.overall !== null &&
    candidate.reliability !== null &&
    candidate.reliability >= config.recognitionQualityFloor
  );
}

/**
 * Winners per positive category. Ties return every tied mentor rather than
 * picking one arbitrarily. There is deliberately no bottom-of-the-list output.
 */
export function selectRecognition(
  candidates: readonly RecognitionCandidate[],
  config: MentorScoreConfig,
): Record<RecognitionCategory, string[]> {
  const eligible = candidates.filter((candidate) => isRecognitionEligible(candidate, config));

  const best = (value: (candidate: RecognitionCandidate) => number | null): string[] => {
    let top = -Infinity;
    let winners: string[] = [];
    for (const candidate of eligible) {
      const score = value(candidate);
      if (score === null) continue;
      if (score > top) {
        top = score;
        winners = [candidate.mentorId];
      } else if (score === top) {
        winners.push(candidate.mentorId);
      }
    }
    return winners.sort();
  };

  const improvement = (candidate: RecognitionCandidate): number | null => {
    const delta = scoreDelta(candidate.overall, candidate.previousOverall);
    return delta !== null && delta > 0 ? delta : null;
  };

  return {
    top_overall: best((candidate) => candidate.overall),
    most_improved: best(improvement),
    reliable_data: best((candidate) => candidate.reliability),
    strong_coverage: best((candidate) => candidate.compliance),
  };
}
