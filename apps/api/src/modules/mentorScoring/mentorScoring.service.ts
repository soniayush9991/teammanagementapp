import {
  computeMentorScore,
  median,
  primaryAction,
  scoreDelta,
  selectNudges,
  validateScoreConfig,
  type MentorScoreConfig,
  type MentorScoreResult,
  type Nudge,
} from '@teamspace/shared';
import { query, queryOne, queryRows, withTransaction } from '../../db/pool.js';
import { recordAudit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import type { AuthenticatedActor } from '../../middleware/auth.js';
import {
  DATE,
  PERIOD_COLUMNS,
  evaluatePeriod,
  hydrateConfig,
  loadConfigById,
  loadConfigForPeriodStart,
  loadPeriod,
  type PeriodRow,
} from './mentorScoring.calc.js';

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * SQL restricting `column` (a mentor user id) to what the actor may see.
 * Admins see everyone; managers their reporting line; nobody else gets here
 * (the route guard has already required a team-level permission).
 */
function mentorScope(actor: AuthenticatedActor, column: string, params: unknown[]): string {
  if (actor.role === 'admin') return 'TRUE';
  params.push(actor.id);
  const slot = `$${params.length}`;
  return `${column} IN (
    WITH RECURSIVE reports AS (
      SELECT id FROM users WHERE manager_id = ${slot}
      UNION
      SELECT u.id FROM users u JOIN reports r ON u.manager_id = r.id
    ) SELECT id FROM reports
  )`;
}

async function assertMentorInScope(actor: AuthenticatedActor, mentorId: string): Promise<void> {
  const params: unknown[] = [mentorId, actor.orgId];
  const scope = mentorScope(actor, 'p.user_id', params);
  const row = await queryOne(
    `SELECT 1 FROM mentor_profiles p WHERE p.user_id = $1 AND p.org_id = $2 AND ${scope}`,
    params,
  );
  // Out-of-scope and nonexistent look the same: no probing for who exists.
  if (!row) throw ApiError.notFound('Mentor');
}

// ---------------------------------------------------------------------------
// Row shapes shared by the report card and the admin drill-down
// ---------------------------------------------------------------------------

interface ScoreRow {
  id: string;
  mentor_id: string;
  period_id: string;
  version: number;
  overall: number | null;
  compliance: number | null;
  reliability: number | null;
  status: 'final' | 'provisional' | 'insufficient_data';
  status_reasons: string[];
  under_review: boolean;
  evidence_counts: Record<string, unknown>;
  config_version_id: string;
  calculated_at: Date;
  recalculated_at: Date | null;
}

const SCORE_COLUMNS = `
  s.id, s.mentor_id, s.period_id, s.version, s.overall::float8 AS overall, s.compliance::float8 AS compliance,
  s.reliability::float8 AS reliability, s.status, s.status_reasons, s.under_review, s.evidence_counts,
  s.config_version_id, s.calculated_at, s.recalculated_at
`;

interface MetricRow {
  metric_code: string;
  numerator: number;
  denominator: number;
  raw_value: number | null;
  weight: number;
  effective_weight: number;
  weighted_value: number;
  rule_version: number;
  applicability_status: string;
}

async function loadMetrics(scoreId: string): Promise<MetricRow[]> {
  return queryRows<MetricRow>(
    `SELECT metric_code, numerator::float8 AS numerator, denominator::float8 AS denominator,
            raw_value::float8 AS raw_value, weight::float8 AS weight, effective_weight::float8 AS effective_weight,
            weighted_value::float8 AS weighted_value, rule_version, applicability_status
     FROM mentor_score_metrics WHERE mentor_score_id = $1
     ORDER BY CASE metric_code
       WHEN 'visit_coverage' THEN 1 WHEN 'duration_validity' THEN 2 WHEN 'spot_completion' THEN 3
       WHEN 'inflation_reliability' THEN 4 ELSE 5 END`,
    [scoreId],
  );
}

/** Rebuilds the engine's result shape from stored rows so nudges match what was calculated. */
function resultFromStored(score: ScoreRow, metrics: MetricRow[]): MentorScoreResult {
  const evidence = score.evidence_counts as unknown as MentorScoreResult['evidence'];
  return {
    status: score.status,
    statusReasons: score.status_reasons as MentorScoreResult['statusReasons'],
    overall: score.overall,
    compliance: score.compliance,
    reliability: score.reliability,
    underReview: score.under_review,
    evidence,
    metrics: metrics.map((metric) => ({
      code: metric.metric_code as MentorScoreResult['metrics'][number]['code'],
      component: metric.metric_code.endsWith('_reliability') ? 'reliability' : 'compliance',
      numerator: metric.numerator,
      denominator: metric.denominator,
      rawValue: metric.raw_value,
      applicable: metric.applicability_status === 'applicable',
      weight: metric.weight,
      effectiveWeight: metric.effective_weight,
      weightedValue: metric.weighted_value,
    })),
  };
}

function presentMetric(metric: MetricRow) {
  return {
    code: metric.metric_code,
    numerator: metric.numerator,
    denominator: metric.denominator,
    value: metric.raw_value,
    applicable: metric.applicability_status === 'applicable',
    weight: metric.weight,
    effectiveWeight: metric.effective_weight,
    points: metric.weighted_value,
    ruleVersion: metric.rule_version,
  };
}

/** Mentors see whole points; the backend keeps two decimals. */
const display = (value: number | null): number | null => (value === null ? null : Math.round(value));

interface HistoryRow {
  period_id: string;
  start_date: string;
  end_date: string;
  overall: number | null;
  compliance: number | null;
  reliability: number | null;
  status: ScoreRow['status'];
  version: number;
}

async function loadHistory(
  mentorId: string,
  orgId: string,
  visibleOnly: boolean,
  limit: number,
  upToStart: string | null = null,
): Promise<HistoryRow[]> {
  return queryRows<HistoryRow>(
    `
    SELECT p.id AS period_id, ${DATE('p.start_date')} AS start_date, ${DATE('p.end_date')} AS end_date,
           s.overall::float8 AS overall, s.compliance::float8 AS compliance, s.reliability::float8 AS reliability,
           s.status, s.version
    FROM mentor_scores s
    JOIN scoring_periods p ON p.id = s.period_id
    WHERE s.mentor_id = $1 AND s.org_id = $2 AND s.is_current AND p.status = 'closed'
      AND ($3::boolean = FALSE OR p.published_at IS NOT NULL)
      AND ($5::date IS NULL OR p.start_date <= $5::date)
    ORDER BY p.start_date DESC
    LIMIT $4
    `,
    [mentorId, orgId, visibleOnly, limit, upToStart],
  );
}

/** Deltas compare consecutive periods that both have a number; otherwise null. */
function withDeltas(rows: HistoryRow[]) {
  return rows.map((row, index) => {
    const previous = rows[index + 1];
    return {
      periodId: row.period_id,
      startDate: row.start_date,
      endDate: row.end_date,
      overall: display(row.overall),
      compliance: display(row.compliance),
      reliability: display(row.reliability),
      status: row.status,
      delta: scoreDelta(row.overall, previous?.overall ?? null),
      revision: row.version,
    };
  });
}

// ---------------------------------------------------------------------------
// Mentor-facing reads
// ---------------------------------------------------------------------------

async function resolveVisiblePeriod(actor: AuthenticatedActor, periodId: string | undefined) {
  const period = periodId
    ? await queryOne<PeriodRow>(
        `SELECT ${PERIOD_COLUMNS} FROM scoring_periods WHERE id = $1 AND org_id = $2 AND status = 'closed' AND published_at IS NOT NULL`,
        [periodId, actor.orgId],
      )
    : await queryOne<PeriodRow>(
        `SELECT ${PERIOD_COLUMNS} FROM scoring_periods
         WHERE org_id = $1 AND status = 'closed' AND published_at IS NOT NULL
         ORDER BY start_date DESC LIMIT 1`,
        [actor.orgId],
      );
  if (!period) throw ApiError.notFound('Report card');
  return period;
}

async function loadCurrentScore(mentorId: string, periodId: string, orgId: string): Promise<ScoreRow | null> {
  return queryOne<ScoreRow>(
    `SELECT ${SCORE_COLUMNS} FROM mentor_scores s WHERE s.mentor_id = $1 AND s.period_id = $2 AND s.org_id = $3 AND s.is_current`,
    [mentorId, periodId, orgId],
  );
}

/** M1-M2: the mentor's own report card. Only ever the caller's own data. */
export async function getReportCard(actor: AuthenticatedActor, periodId?: string) {
  const period = await resolveVisiblePeriod(actor, periodId);
  const score = await loadCurrentScore(actor.id, period.id, actor.orgId);
  if (!score) throw ApiError.notFound('Report card');
  return presentReportCard(actor.orgId, actor.id, period, score, true);
}

export async function presentReportCard(
  orgId: string,
  mentorId: string,
  period: PeriodRow,
  score: ScoreRow,
  visibleOnly: boolean,
) {
  const metrics = await loadMetrics(score.id);
  const result = resultFromStored(score, metrics);
  // Trend and "previous period" are relative to the card being shown, not to today.
  const history = await loadHistory(mentorId, orgId, visibleOnly, 4, period.start_date);
  const trend = withDeltas(history);
  const index = history.findIndex((row) => row.period_id === period.id);
  const previous = index >= 0 ? history[index + 1] : undefined;

  const benchmark = await queryOne<{ value: number | null; cohort_size: number; suppressed: boolean }>(
    `
    SELECT b.value::float8 AS value, b.cohort_size, b.suppressed
    FROM benchmark_snapshots b
    JOIN mentor_profiles mp ON mp.user_id = $1
    WHERE b.period_id = $2 AND b.geography = COALESCE(mp.district, '*') AND b.mentor_role = mp.mentor_role
    `,
    [mentorId, period.id],
  );

  const nudges: Nudge[] = selectNudges(result, previous?.overall ?? null);
  const updated =
    score.version > 1
      ? await queryOne<{ created_at: Date; reason: string | null }>(
          `SELECT created_at, reason FROM score_events
           WHERE mentor_id = $1 AND period_id = $2 AND event_type = 'recalculated'
           ORDER BY created_at DESC LIMIT 1`,
          [mentorId, period.id],
        )
      : null;

  return {
    period: { id: period.id, startDate: period.start_date, endDate: period.end_date },
    status: score.status,
    statusReasons: score.status_reasons,
    // The number is shown only when it is valid for the period (M1.3).
    overall: score.status === 'insufficient_data' ? null : display(score.overall),
    compliance: score.status === 'insufficient_data' ? null : display(score.compliance),
    reliability: score.status === 'insufficient_data' ? null : display(score.reliability),
    underReview: score.under_review,
    previousOverall: display(previous?.overall ?? null),
    delta: scoreDelta(score.overall, previous?.overall ?? null),
    updated: updated ? { at: updated.created_at, reason: updated.reason, revision: score.version } : null,
    metrics: metrics.map(presentMetric),
    trend: trend.slice(0, 3),
    benchmark: benchmark
      ? {
          label: 'District median',
          value: benchmark.suppressed ? null : benchmark.value,
          suppressed: benchmark.suppressed,
        }
      : null,
    primaryAction: primaryAction(result),
    nudges,
    definitions:
      'This score measures visit coverage and the reliability of recorded data. It is not a measure of teaching quality.',
  };
}

interface VisitEvidenceRow {
  id: string;
  school_id: string;
  started_at: Date;
  ended_at: Date;
  completed: boolean;
  spot_applicable: number;
  spot_completed: number;
  inflation_checks: number;
  consistency_checks: number;
}

/** M3-M5: the visits and flags behind a report card, described at a high level. */
export async function getEvidence(actor: AuthenticatedActor, periodId: string) {
  const period = await resolveVisiblePeriod(actor, periodId);
  return buildEvidence(actor.orgId, actor.id, period, false);
}

const REASON_LABELS: Record<string, string> = {
  invalid_assignment: 'School was not in your assignment',
  invalid_timestamps: 'Visit times were not valid',
  location_unverified: 'Location could not be verified',
  incomplete: 'Visit was not completed',
  duplicate: 'Duplicate of another visit',
  system_record: 'Test, cancelled or deleted record',
};

export async function buildEvidence(orgId: string, mentorId: string, period: PeriodRow, adminView: boolean) {
  const score = await loadCurrentScore(mentorId, period.id, orgId);
  if (!score) throw ApiError.notFound('Report card');
  const metrics = await loadMetrics(score.id);
  const configRow = await withTransaction((client) => loadConfigById(client, score.config_version_id));

  const evaluated = await withTransaction(async (client) => {
    const all = await evaluatePeriod(client, orgId, period, configRow.config);
    return all.find((entry) => entry.mentor.user_id === mentorId) ?? null;
  });

  const visits = await queryRows<VisitEvidenceRow>(
    `SELECT id, school_id, started_at, ended_at, completed, spot_applicable, spot_completed, inflation_checks, consistency_checks
     FROM mentoring_visits WHERE id = ANY($1::uuid[]) ORDER BY started_at`,
    [evaluated?.visitIds ?? []],
  );
  const assessments = new Map((evaluated?.assessed.assessments ?? []).map((entry) => [entry.visitId, entry]));

  const flags = await queryRows<{
    id: string;
    visit_id: string;
    kind: string;
    severity: string;
    status: string;
    explanation: string;
    rule_code: string;
    created_at: Date;
    resolved_at: Date | null;
  }>(
    `
    SELECT f.id, f.visit_id, f.kind, f.severity, f.status, f.explanation, f.rule_code, f.created_at, f.resolved_at
    FROM quality_flags f
    JOIN mentoring_visits v ON v.id = f.visit_id
    JOIN organizations o ON o.id = f.org_id
    WHERE f.mentor_id = $1 AND f.org_id = $2
      AND ((v.started_at AT TIME ZONE o.timezone)::date BETWEEN $3::date AND $4::date OR f.carried_into_period_id = $5)
    ORDER BY f.created_at
    `,
    [mentorId, orgId, period.start_date, period.end_date, period.id],
  );

  const exclusions = {
    expectedVisitsTarget: (evaluated?.expected.target ?? null) as number | null,
    activeDays: evaluated?.expected.activeDays ?? null,
    excludedDays: evaluated?.expected.excludedDays ?? null,
    // Mentors get the category only (leave / training / outage / invalid record), never reasons from other people.
    note: 'Days on approved leave, training or declared system outages are removed from the expected visits.',
  };

  return {
    period: { id: period.id, startDate: period.start_date, endDate: period.end_date },
    metrics: metrics.map(presentMetric),
    exclusions,
    visits: visits.map((visit) => {
      const assessment = assessments.get(visit.id);
      return {
        id: visit.id,
        schoolId: visit.school_id,
        startedAt: visit.started_at,
        endedAt: visit.ended_at,
        counted: assessment?.eligible ?? false,
        durationMinutes: assessment?.durationMinutes ?? null,
        durationValid: assessment?.durationValid ?? false,
        spotApplicable: visit.spot_applicable,
        spotCompleted: Math.min(visit.spot_completed, visit.spot_applicable),
        inflationChecks: visit.inflation_checks,
        consistencyChecks: visit.consistency_checks,
        reasons: (assessment?.reasons ?? ['duplicate']).map((reason) => (adminView ? reason : REASON_LABELS[reason] ?? reason)),
      };
    }),
    flags: flags.map((flag) => ({
      id: flag.id,
      visitId: flag.visit_id,
      kind: flag.kind,
      status: flag.status,
      // M5 wording: a flag is not a penalty; only "confirmed" affected the score.
      affectsScore: flag.status === 'confirmed',
      why: flag.explanation,
      createdAt: flag.created_at,
      resolvedAt: flag.resolved_at,
      ...(adminView ? { ruleCode: flag.rule_code, severity: flag.severity } : {}),
    })),
  };
}

/** M6: completed, published periods with the numbers each was calculated with. */
export async function getHistory(actor: AuthenticatedActor) {
  return { items: withDeltas(await loadHistory(actor.id, actor.orgId, true, 24)) };
}

// ---------------------------------------------------------------------------
// Admin: scores
// ---------------------------------------------------------------------------

export interface ScoreFilter {
  periodId?: string;
  district?: string;
  block?: string;
  role?: string;
  status?: string;
  limit: number;
  offset: number;
}

async function latestClosedPeriod(orgId: string): Promise<PeriodRow> {
  const period = await queryOne<PeriodRow>(
    `SELECT ${PERIOD_COLUMNS} FROM scoring_periods WHERE org_id = $1 AND status = 'closed' ORDER BY start_date DESC LIMIT 1`,
    [orgId],
  );
  if (!period) throw ApiError.notFound('Closed scoring period');
  return period;
}

async function periodForAdmin(orgId: string, periodId: string | undefined): Promise<PeriodRow> {
  if (!periodId) return latestClosedPeriod(orgId);
  const period = await queryOne<PeriodRow>(
    `SELECT ${PERIOD_COLUMNS} FROM scoring_periods WHERE id = $1 AND org_id = $2`,
    [periodId, orgId],
  );
  if (!period) throw ApiError.notFound('Scoring period');
  return period;
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const value = (sorted[lower] as number) + ((sorted[upper] as number) - (sorted[lower] as number)) * (position - lower);
  return Math.round(value * 100) / 100;
}

export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    q1: quantile(sorted, 0.25),
    median: median(sorted),
    q3: quantile(sorted, 0.75),
    max: sorted.at(-1) ?? null,
    mean: sorted.length ? Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 100) / 100 : null,
  };
}

/** A1-A2: filtered mentor list with the aggregates the overview cards need. */
export async function listScores(actor: AuthenticatedActor, filter: ScoreFilter) {
  const period = await periodForAdmin(actor.orgId, filter.periodId);
  const params: unknown[] = [actor.orgId, period.id];
  const where = ['s.org_id = $1', 's.period_id = $2', 's.is_current'];
  const scope = mentorScope(actor, 's.mentor_id', params);
  where.push(scope);
  for (const [column, value] of [
    ['mp.district', filter.district],
    ['mp.block', filter.block],
    ['mp.mentor_role', filter.role],
    ['s.status', filter.status],
  ] as const) {
    if (value) {
      params.push(value);
      where.push(`${column} = $${params.length}${column === 's.status' ? '::score_status' : ''}`);
    }
  }

  const startSlot = params.push(period.start_date);
  const endSlot = params.push(period.end_date);
  const rows = await queryRows<
    ScoreRow & { display_name: string; mentor_role: string; district: string | null; block: string | null; flagged: number; confirmed: number }
  >(
    `
    SELECT ${SCORE_COLUMNS}, u.display_name, mp.mentor_role, mp.district, mp.block,
      (SELECT count(*)::int FROM quality_flags f JOIN mentoring_visits v ON v.id = f.visit_id
         JOIN organizations o ON o.id = f.org_id
         WHERE f.mentor_id = s.mentor_id AND f.status IN ('new','in_review','escalated')
           AND (v.started_at AT TIME ZONE o.timezone)::date BETWEEN $${startSlot}::date AND $${endSlot}::date) AS flagged,
      (SELECT count(*)::int FROM quality_flags f JOIN mentoring_visits v ON v.id = f.visit_id
         JOIN organizations o ON o.id = f.org_id
         WHERE f.mentor_id = s.mentor_id AND f.status = 'confirmed'
           AND (v.started_at AT TIME ZONE o.timezone)::date BETWEEN $${startSlot}::date AND $${endSlot}::date) AS confirmed
    FROM mentor_scores s
    JOIN users u ON u.id = s.mentor_id
    JOIN mentor_profiles mp ON mp.user_id = s.mentor_id
    WHERE ${where.join(' AND ')}
    ORDER BY u.display_name
    `,
    params,
  );

  // Previous-period overall per mentor, for the trend column.
  const previous = new Map<string, number | null>();
  if (rows.length > 0) {
    const prior = await queryRows<{ mentor_id: string; overall: number | null }>(
      `
      SELECT DISTINCT ON (s.mentor_id) s.mentor_id, s.overall::float8 AS overall
      FROM mentor_scores s JOIN scoring_periods p ON p.id = s.period_id
      WHERE s.org_id = $1 AND s.is_current AND p.status = 'closed' AND p.start_date < $2::date
        AND s.mentor_id = ANY($3::uuid[])
      ORDER BY s.mentor_id, p.start_date DESC
      `,
      [actor.orgId, period.start_date, rows.map((row) => row.mentor_id)],
    );
    for (const row of prior) previous.set(row.mentor_id, row.overall);
  }

  const scored = rows.filter((row) => row.overall !== null);
  const evidenceOf = (row: (typeof rows)[number]) => row.evidence_counts as unknown as MentorScoreResult['evidence'];
  const sum = (pick: (e: MentorScoreResult['evidence']) => number) => rows.reduce((total, row) => total + pick(evidenceOf(row)), 0);
  const expected = sum((e) => e.expectedVisits);
  const checks = sum((e) => e.inflationChecks + e.consistencyChecks);
  const confirmedIssues = sum((e) => e.confirmedInflation + e.confirmedContradictions);
  const finals = rows.filter((row) => row.status === 'final').length;
  const provisionals = rows.filter((row) => row.status === 'provisional').length;

  return {
    period: { id: period.id, startDate: period.start_date, endDate: period.end_date, status: period.status, published: period.published_at !== null },
    summary: {
      mentors: rows.length,
      averageScore: distribution(scored.map((row) => row.overall as number)).mean,
      medianScore: distribution(scored.map((row) => row.overall as number)).median,
      percentFinal: rows.length ? Math.round((finals / rows.length) * 1000) / 10 : null,
      percentProvisional: rows.length ? Math.round((provisionals / rows.length) * 1000) / 10 : null,
      validVisitCoverage: expected > 0 ? Math.round((sum((e) => Math.min(e.eligibleVisits, e.expectedVisits)) / expected) * 1000) / 10 : null,
      confirmedIntegrityIssueRate: checks > 0 ? Math.round((confirmedIssues / checks) * 10000) / 100 : null,
      distribution: distribution(scored.map((row) => row.overall as number)),
      compliance: distribution(rows.filter((row) => row.compliance !== null).map((row) => row.compliance as number)),
      reliability: distribution(rows.filter((row) => row.reliability !== null).map((row) => row.reliability as number)),
    },
    items: rows.slice(filter.offset, filter.offset + filter.limit).map((row) => {
      const evidence = evidenceOf(row);
      return {
        mentorId: row.mentor_id,
        name: row.display_name,
        role: row.mentor_role,
        district: row.district,
        block: row.block,
        overall: row.overall,
        compliance: row.compliance,
        reliability: row.reliability,
        status: row.status,
        delta: scoreDelta(row.overall, previous.get(row.mentor_id) ?? null),
        flags: { flagged: row.flagged, confirmed: row.confirmed },
        visits: { valid: evidence.eligibleVisits, expected: evidence.expectedVisits },
        revision: row.version,
      };
    }),
    total: rows.length,
  };
}

/** A3: everything behind one mentor's score, including reviewer decisions and score events. */
export async function getMentorDrilldown(actor: AuthenticatedActor, mentorId: string, periodId?: string) {
  await assertMentorInScope(actor, mentorId);
  const period = await periodForAdmin(actor.orgId, periodId);
  if (period.status !== 'closed') throw ApiError.unprocessable('This period has not been scored yet');

  const profile = await queryOne<{ display_name: string; mentor_role: string; district: string | null; block: string | null; active_from: string | null; active_to: string | null }>(
    `SELECT u.display_name, mp.mentor_role, mp.district, mp.block,
            ${DATE('mp.active_from')} AS active_from, ${DATE('mp.active_to')} AS active_to
     FROM mentor_profiles mp JOIN users u ON u.id = mp.user_id WHERE mp.user_id = $1`,
    [mentorId],
  );
  const score = await loadCurrentScore(mentorId, period.id, actor.orgId);
  if (!score) throw ApiError.notFound('Mentor score');

  const [card, evidence, reviews, events, history, config] = await Promise.all([
    presentReportCard(actor.orgId, mentorId, period, score, false),
    buildEvidence(actor.orgId, mentorId, period, true),
    queryRows(
      `SELECT r.id, r.flag_id, r.decision, r.from_status, r.to_status, r.reason_code, r.note, r.decided_at,
              u.display_name AS reviewer
       FROM audit_reviews r
       JOIN quality_flags f ON f.id = r.flag_id
       JOIN mentoring_visits v ON v.id = f.visit_id
       JOIN organizations o ON o.id = f.org_id
       LEFT JOIN users u ON u.id = r.reviewer_id
       WHERE f.mentor_id = $1 AND (v.started_at AT TIME ZONE o.timezone)::date BETWEEN $2::date AND $3::date
       ORDER BY r.decided_at`,
      [mentorId, period.start_date, period.end_date],
    ),
    queryRows(
      `SELECT e.event_type, e.before_value, e.after_value, e.reason, e.created_at, u.display_name AS actor
       FROM score_events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.mentor_id = $1 AND e.period_id = $2 ORDER BY e.created_at, e.id`,
      [mentorId, period.id],
    ),
    loadHistory(mentorId, actor.orgId, false, 6),
    withTransaction((client) => loadConfigById(client, score.config_version_id)),
  ]);

  return {
    mentor: { id: mentorId, name: profile?.display_name, role: profile?.mentor_role, district: profile?.district, block: profile?.block, activeFrom: profile?.active_from, activeTo: profile?.active_to },
    period: card.period,
    scores: { overall: score.overall, compliance: score.compliance, reliability: score.reliability, status: score.status, revision: score.version },
    configVersion: config.version,
    drivers: card.metrics,
    evidence,
    reviews,
    events,
    trend: withDeltas(history),
  };
}

// ---------------------------------------------------------------------------
// Admin: configuration and periods
// ---------------------------------------------------------------------------

export async function getActiveConfig(actor: AuthenticatedActor) {
  const row = await queryOne<{ id: string; version: number; effective_from: string; config: unknown; created_at: Date }>(
    `SELECT id, version, ${DATE('effective_from')} AS effective_from, config, created_at
     FROM mentor_score_configs WHERE org_id = $1 ORDER BY version DESC LIMIT 1`,
    [actor.orgId],
  );
  return row
    ? { id: row.id, version: row.version, effectiveFrom: row.effective_from, config: hydrateConfig(row.config), createdAt: row.created_at }
    : null;
}

export async function publishConfig(
  actor: AuthenticatedActor,
  input: { config: MentorScoreConfig; effectiveFrom: string; note?: string },
) {
  const config = hydrateConfig(input.config);
  const problems = validateScoreConfig(config);
  if (problems.length > 0) throw ApiError.unprocessable('Configuration is invalid', problems);

  return withTransaction(async (client) => {
    // Serialises concurrent publishes so version numbers stay gapless.
    await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [actor.orgId]);

    // A closed period keeps the version it was frozen on, but a new version
    // dated inside or before one would mislead anyone reading the timeline.
    const closed = await client.query<{ end_date: string }>(
      `SELECT ${DATE('max(end_date)')} AS end_date FROM scoring_periods WHERE org_id = $1 AND status = 'closed'`,
      [actor.orgId],
    );
    const lastClosedEnd = closed.rows[0]?.end_date;
    if (lastClosedEnd && input.effectiveFrom <= lastClosedEnd) {
      throw ApiError.unprocessable(`effectiveFrom must be after the last closed period (${lastClosedEnd}); closed scores are never changed`);
    }

    const { rows } = await client.query<{ id: string; version: number }>(
      `INSERT INTO mentor_score_configs (org_id, version, config, effective_from, note, created_by)
       VALUES ($1, COALESCE((SELECT max(version) FROM mentor_score_configs WHERE org_id = $1), 0) + 1, $2::jsonb, $3, $4, $5)
       RETURNING id, version`,
      [actor.orgId, JSON.stringify(config), input.effectiveFrom, input.note ?? null, actor.id],
    );
    await recordAudit(
      {
        orgId: actor.orgId,
        actorId: actor.id,
        action: 'mentor_score.config_published',
        entityType: 'mentor_score_config',
        entityId: rows[0]!.id,
        metadata: { version: rows[0]!.version, effectiveFrom: input.effectiveFrom, note: input.note ?? null },
      },
      client,
    );
    return { configVersionId: rows[0]!.id, version: rows[0]!.version, effectiveFrom: input.effectiveFrom };
  });
}

/**
 * A "what if" run: the same frozen evidence scored under the period's own
 * configuration and under a candidate. Nothing is written.
 */
export async function previewConfig(actor: AuthenticatedActor, periodId: string, candidate: MentorScoreConfig) {
  const config = hydrateConfig(candidate);
  const problems = validateScoreConfig(config);
  if (problems.length > 0) throw ApiError.unprocessable('Candidate configuration is invalid', problems);

  return withTransaction(async (client) => {
    const period = await loadPeriod(client, actor.orgId, periodId);
    const current = period.config_version_id
      ? await loadConfigById(client, period.config_version_id)
      : await loadConfigForPeriodStart(client, actor.orgId, period.start_date);
    const entries = await evaluatePeriod(client, actor.orgId, period, current.config);

    const rows = entries.map((entry) => {
      const after = computeMentorScore(entry.score, config);
      return {
        mentorId: entry.mentor.user_id,
        before: { overall: entry.result.overall, status: entry.result.status },
        after: { overall: after.overall, status: after.status },
        change: entry.result.overall !== null && after.overall !== null ? Math.round((after.overall - entry.result.overall) * 100) / 100 : null,
      };
    });
    return {
      periodId,
      baselineConfigVersion: current.version,
      before: distribution(rows.flatMap((row) => (row.before.overall === null ? [] : [row.before.overall]))),
      after: distribution(rows.flatMap((row) => (row.after.overall === null ? [] : [row.after.overall]))),
      statusChanges: rows.filter((row) => row.before.status !== row.after.status).length,
      mentors: rows,
    };
  });
}

export async function createPeriod(actor: AuthenticatedActor, startDate: string) {
  return withTransaction(async (client) => {
    let periodDays = 14;
    try {
      periodDays = (await loadConfigForPeriodStart(client, actor.orgId, startDate)).config.periodDays;
    } catch {
      // No configuration yet: the default period length applies; closing will demand a config.
    }
    const overlap = await client.query(
      `SELECT 1 FROM scoring_periods WHERE org_id = $1 AND daterange(start_date, end_date, '[]') && daterange($2::date, ($2::date + $3::int - 1), '[]')`,
      [actor.orgId, startDate, periodDays],
    );
    if (overlap.rows.length > 0) throw ApiError.conflict('This period overlaps an existing scoring period');
    const { rows } = await client.query<PeriodRow>(
      `INSERT INTO scoring_periods (org_id, start_date, end_date, created_by)
       VALUES ($1, $2::date, ($2::date + $3::int - 1), $4)
       RETURNING ${PERIOD_COLUMNS}`,
      [actor.orgId, startDate, periodDays, actor.id],
    );
    await recordAudit(
      { orgId: actor.orgId, actorId: actor.id, action: 'mentor_score.period_created', entityType: 'scoring_period', entityId: rows[0]!.id },
      client,
    );
    return rows[0]!;
  });
}

export async function listPeriods(actor: AuthenticatedActor) {
  const rows = await queryRows<PeriodRow>(
    `SELECT ${PERIOD_COLUMNS} FROM scoring_periods WHERE org_id = $1 ORDER BY start_date DESC LIMIT 60`,
    [actor.orgId],
  );
  return { items: rows };
}

/** Moves a closed period out of shadow mode so mentors can see their cards. */
export async function publishPeriod(actor: AuthenticatedActor, periodId: string) {
  return withTransaction(async (client) => {
    const period = await loadPeriod(client, actor.orgId, periodId, true);
    if (period.status !== 'closed') throw ApiError.unprocessable('Close the period before publishing report cards');
    if (period.published_at) throw ApiError.conflict('Report cards for this period are already published');
    await client.query(`UPDATE scoring_periods SET published_at = now() WHERE id = $1`, [periodId]);
    await client.query(
      `INSERT INTO score_events (org_id, mentor_id, period_id, event_type, actor_id, reason)
       SELECT $1, s.mentor_id, $2, 'published', $3, 'Report cards published'
       FROM mentor_scores s WHERE s.period_id = $2 AND s.is_current`,
      [actor.orgId, periodId, actor.id],
    );
    await recordAudit(
      { orgId: actor.orgId, actorId: actor.id, action: 'mentor_score.period_published', entityType: 'scoring_period', entityId: periodId },
      client,
    );
    return { periodId, publishedAt: new Date().toISOString() };
  });
}

// ---------------------------------------------------------------------------
// Admin: setup (mentor profiles, exclusions) and visit intake
// ---------------------------------------------------------------------------

export async function upsertMentorProfile(
  actor: AuthenticatedActor,
  userId: string,
  input: { mentorRole: string; district?: string | null; block?: string | null; activeFrom?: string | null; activeTo?: string | null },
) {
  const user = await queryOne(`SELECT 1 FROM users WHERE id = $1 AND org_id = $2`, [userId, actor.orgId]);
  if (!user) throw ApiError.notFound('User');
  await query(
    `
    INSERT INTO mentor_profiles (user_id, org_id, mentor_role, district, block, active_from, active_to)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (user_id) DO UPDATE SET mentor_role = EXCLUDED.mentor_role, district = EXCLUDED.district,
      block = EXCLUDED.block, active_from = EXCLUDED.active_from, active_to = EXCLUDED.active_to, updated_at = now()
    `,
    [userId, actor.orgId, input.mentorRole, input.district ?? null, input.block ?? null, input.activeFrom ?? null, input.activeTo ?? null],
  );
  await recordAudit({ orgId: actor.orgId, actorId: actor.id, action: 'mentor_score.profile_set', entityType: 'user', entityId: userId, metadata: input });
  return { userId, ...input };
}

export async function createExclusion(
  actor: AuthenticatedActor,
  input: { userId?: string | null; kind: string; startDate: string; endDate: string; reason: string },
) {
  if (input.userId) {
    const user = await queryOne(`SELECT 1 FROM users WHERE id = $1 AND org_id = $2`, [input.userId, actor.orgId]);
    if (!user) throw ApiError.notFound('User');
  }
  const row = await queryOne<{ id: string }>(
    `INSERT INTO scoring_exclusions (org_id, user_id, kind, start_date, end_date, reason, created_by)
     VALUES ($1, $2, $3::exclusion_kind, $4, $5, $6, $7) RETURNING id`,
    [actor.orgId, input.userId ?? null, input.kind, input.startDate, input.endDate, input.reason, actor.id],
  );
  await recordAudit({ orgId: actor.orgId, actorId: actor.id, action: 'mentor_score.exclusion_created', entityType: 'scoring_exclusion', entityId: row!.id, metadata: input });
  return { id: row!.id };
}

export interface VisitInput {
  id: string;
  schoolId: string;
  visitType?: string;
  startedAt: string;
  endedAt: string;
  completed?: boolean;
  assignmentValid?: boolean;
  location?: 'verified' | 'exception' | 'unverified' | 'failed';
  isTest?: boolean;
  spotApplicable?: number;
  spotCompleted?: number;
  inflationChecks?: number;
  consistencyChecks?: number;
}

/**
 * Idempotent on the client-generated id: a retry or an offline re-sync of the
 * same visit returns the stored record and never creates a second one.
 */
export async function submitVisit(actor: AuthenticatedActor, input: VisitInput) {
  const profile = await queryOne(`SELECT 1 FROM mentor_profiles WHERE user_id = $1`, [actor.id]);
  if (!profile) throw ApiError.forbidden('You are not registered as a mentor');

  const inserted = await queryOne<{ id: string }>(
    `
    INSERT INTO mentoring_visits
      (id, org_id, mentor_id, school_id, visit_type, started_at, ended_at, completed, assignment_valid,
       location_status, is_test, spot_applicable, spot_completed, inflation_checks, consistency_checks)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::visit_location_status, $11, $12, $13, $14, $15)
    ON CONFLICT (id) DO NOTHING
    RETURNING id
    `,
    [
      input.id,
      actor.orgId,
      actor.id,
      input.schoolId,
      input.visitType ?? 'standard',
      input.startedAt,
      input.endedAt,
      input.completed ?? true,
      input.assignmentValid ?? true,
      input.location ?? 'verified',
      input.isTest ?? false,
      input.spotApplicable ?? 0,
      Math.min(input.spotCompleted ?? 0, input.spotApplicable ?? 0),
      input.inflationChecks ?? 0,
      input.consistencyChecks ?? 0,
    ],
  );
  if (inserted) return { id: input.id, created: true };

  const existing = await queryOne<{ mentor_id: string }>(`SELECT mentor_id FROM mentoring_visits WHERE id = $1`, [input.id]);
  if (existing?.mentor_id !== actor.id) throw ApiError.conflict('This visit id is already in use');
  return { id: input.id, created: false };
}

// ---------------------------------------------------------------------------
// Admin: quality flags
// ---------------------------------------------------------------------------

export interface FlagFilter {
  status?: string;
  district?: string;
  block?: string;
  mentorId?: string;
  kind?: string;
  periodId?: string;
  limit: number;
  offset: number;
}

export async function listFlags(actor: AuthenticatedActor, filter: FlagFilter) {
  const params: unknown[] = [actor.orgId];
  const where = ['f.org_id = $1', mentorScope(actor, 'f.mentor_id', params)];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (filter.status) add('f.status = ?::flag_status', filter.status);
  if (filter.district) add('mp.district = ?', filter.district);
  if (filter.block) add('mp.block = ?', filter.block);
  if (filter.mentorId) add('f.mentor_id = ?', filter.mentorId);
  if (filter.kind) add('f.kind = ?::flag_kind', filter.kind);
  if (filter.periodId) {
    params.push(filter.periodId);
    where.push(`(v.started_at AT TIME ZONE o.timezone)::date BETWEEN
      (SELECT start_date FROM scoring_periods WHERE id = $${params.length})
      AND (SELECT end_date FROM scoring_periods WHERE id = $${params.length})`);
  }

  const limitSlot = params.push(filter.limit);
  const offsetSlot = params.push(filter.offset);
  const rows = await queryRows(
    `
    SELECT f.id, f.mentor_id, u.display_name AS mentor_name, mp.district, mp.block, f.visit_id, f.kind,
           f.rule_code, f.severity, f.status, f.explanation, f.evidence_payload, f.created_at,
           -- a repeated pattern raises priority
           (SELECT count(*)::int FROM quality_flags r
              WHERE r.mentor_id = f.mentor_id AND r.rule_code = f.rule_code AND r.id <> f.id
                AND r.created_at > f.created_at - INTERVAL '60 days') AS repeat_count,
           EXTRACT(EPOCH FROM (now() - f.created_at)) / 86400.0 AS age_days,
           v.school_id, v.started_at, v.ended_at, v.location_status,
           count(*) OVER () AS total
    FROM quality_flags f
    JOIN mentoring_visits v ON v.id = f.visit_id
    JOIN organizations o ON o.id = f.org_id
    JOIN users u ON u.id = f.mentor_id
    LEFT JOIN mentor_profiles mp ON mp.user_id = f.mentor_id
    WHERE ${where.join(' AND ')}
    ORDER BY CASE f.status WHEN 'escalated' THEN 0 WHEN 'new' THEN 1 WHEN 'in_review' THEN 2 ELSE 3 END,
             CASE f.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
             repeat_count DESC, f.created_at
    LIMIT $${limitSlot} OFFSET $${offsetSlot}
    `,
    params,
  );
  const total = rows.length > 0 ? Number((rows[0] as { total: string }).total) : 0;
  return { items: rows.map(({ total: _total, ...rest }) => rest), total };
}

export async function createFlag(
  actor: AuthenticatedActor,
  input: { visitId: string; ruleCode: string; kind: 'inflation' | 'contradiction'; severity?: 'low' | 'medium' | 'high'; explanation: string; evidence?: Record<string, unknown> },
) {
  const visit = await queryOne<{ mentor_id: string }>(`SELECT mentor_id FROM mentoring_visits WHERE id = $1 AND org_id = $2`, [input.visitId, actor.orgId]);
  if (!visit) throw ApiError.notFound('Visit');
  await assertMentorInScope(actor, visit.mentor_id);
  const row = await queryOne<{ id: string }>(
    `INSERT INTO quality_flags (org_id, mentor_id, visit_id, rule_code, kind, severity, explanation, evidence_payload)
     VALUES ($1, $2, $3, $4, $5::flag_kind, $6::flag_severity, $7, $8::jsonb)
     ON CONFLICT (visit_id, rule_code) DO NOTHING RETURNING id`,
    [actor.orgId, visit.mentor_id, input.visitId, input.ruleCode, input.kind, input.severity ?? 'medium', input.explanation, JSON.stringify(input.evidence ?? {})],
  );
  if (!row) throw ApiError.conflict('This visit is already flagged by that rule');
  return { id: row.id, status: 'new' };
}

export type FlagDecision = 'start_review' | 'confirm' | 'dismiss' | 'escalate' | 'note';

const TRANSITIONS: Record<Exclude<FlagDecision, 'note'>, { from: string[]; to: string }> = {
  start_review: { from: ['new'], to: 'in_review' },
  escalate: { from: ['new', 'in_review'], to: 'escalated' },
  confirm: { from: ['new', 'in_review', 'escalated'], to: 'confirmed' },
  dismiss: { from: ['new', 'in_review', 'escalated'], to: 'dismissed' },
};

/** A4: every action records reviewer, time, old and new status, and reason. */
export async function decideFlag(
  actor: AuthenticatedActor,
  flagId: string,
  input: { decision: FlagDecision; reasonCode?: string; note?: string },
) {
  if ((input.decision === 'confirm' || input.decision === 'dismiss') && !input.reasonCode) {
    throw ApiError.badRequest('A reason code is required to confirm or dismiss a flag');
  }
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; mentor_id: string; status: string }>(
      `SELECT id, mentor_id, status FROM quality_flags WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [flagId, actor.orgId],
    );
    const flag = rows[0];
    if (!flag) throw ApiError.notFound('Flag');
    await assertMentorInScope(actor, flag.mentor_id);
    if (flag.mentor_id === actor.id) throw ApiError.forbidden('You cannot review a flag on your own record');

    const from = flag.status;
    let to = from;
    if (input.decision !== 'note') {
      const rule = TRANSITIONS[input.decision];
      if (!rule.from.includes(from)) throw ApiError.conflict(`A ${from.replace('_', ' ')} flag cannot be ${input.decision.replace('_', ' ')}ed`);
      // An escalated flag is a request for someone senior to decide.
      if (from === 'escalated' && actor.role !== 'admin') {
        throw ApiError.forbidden('Only an admin can resolve an escalated flag');
      }
      to = rule.to;
      await client.query(
        `UPDATE quality_flags
         SET status = $2::flag_status,
             confirmed_at = CASE WHEN $2 = 'confirmed' THEN now() ELSE confirmed_at END,
             resolved_at = CASE WHEN $2 IN ('confirmed','dismissed') THEN now() ELSE resolved_at END
         WHERE id = $1`,
        [flagId, to],
      );
    }
    await client.query(
      `INSERT INTO audit_reviews (flag_id, reviewer_id, decision, from_status, to_status, reason_code, note)
       VALUES ($1, $2, $3, $4::flag_status, $5::flag_status, $6, $7)`,
      [flagId, actor.id, input.decision, from, to, input.reasonCode ?? null, input.note ?? null],
    );
    await recordAudit(
      {
        orgId: actor.orgId,
        actorId: actor.id,
        action: `mentor_flag.${input.decision}`,
        entityType: 'quality_flag',
        entityId: flagId,
        metadata: { from, to, reasonCode: input.reasonCode ?? null },
      },
      client,
    );
    return { id: flagId, status: to, previousStatus: from };
  });
}

