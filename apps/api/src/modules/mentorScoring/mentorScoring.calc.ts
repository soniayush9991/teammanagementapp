import type { PoolClient } from 'pg';
import {
  DEFAULT_SCORE_CONFIG,
  assessVisits,
  activeDays,
  benchmarkMedian,
  computeMentorScore,
  excludedDays,
  expectedVisits,
  roleTarget,
  validateScoreConfig,
  type DateRange,
  type MentorScoreConfig,
  type MentorScoreResult,
  type ScoreEvidence,
  type VisitRecord,
} from '@teamspace/shared';
import { withTransaction } from '../../db/pool.js';
import { recordAudit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import type { AuthenticatedActor } from '../../middleware/auth.js';

export interface PeriodRow {
  id: string;
  org_id: string;
  start_date: string;
  end_date: string;
  status: 'open' | 'closed';
  config_version_id: string | null;
  closed_at: Date | null;
  published_at: Date | null;
}

export interface MentorRow {
  user_id: string;
  mentor_role: string;
  district: string | null;
  block: string | null;
  active_from: string | null;
  active_to: string | null;
}

export interface ConfigVersion {
  id: string;
  version: number;
  effectiveFrom: string;
  config: MentorScoreConfig;
}

/** Stored configs are merged over the defaults so an older version still loads after a field is added. */
export function hydrateConfig(stored: unknown): MentorScoreConfig {
  const partial = (stored ?? {}) as Partial<MentorScoreConfig>;
  return {
    ...DEFAULT_SCORE_CONFIG,
    ...partial,
    componentWeights: { ...DEFAULT_SCORE_CONFIG.componentWeights, ...partial.componentWeights },
    complianceWeights: { ...DEFAULT_SCORE_CONFIG.complianceWeights, ...partial.complianceWeights },
    reliabilityWeights: { ...DEFAULT_SCORE_CONFIG.reliabilityWeights, ...partial.reliabilityWeights },
    minEvidence: { ...DEFAULT_SCORE_CONFIG.minEvidence, ...partial.minEvidence },
    roleTargets: { ...partial.roleTargets },
  };
}

// Dates come back from pg as Date objects at local midnight unless cast; every
// date column is selected through this so the engine only sees YYYY-MM-DD.
export const DATE = (column: string): string => `to_char(${column}, 'YYYY-MM-DD')`;

export const PERIOD_COLUMNS = `
  id, org_id, ${DATE('start_date')} AS start_date, ${DATE('end_date')} AS end_date,
  status, config_version_id, closed_at, published_at
`;

export async function loadPeriod(client: PoolClient, orgId: string, periodId: string, lock = false): Promise<PeriodRow> {
  const { rows } = await client.query<PeriodRow>(
    `SELECT ${PERIOD_COLUMNS} FROM scoring_periods WHERE id = $1 AND org_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [periodId, orgId],
  );
  if (!rows[0]) throw ApiError.notFound('Scoring period');
  return rows[0];
}

export async function loadConfigById(client: PoolClient, id: string): Promise<ConfigVersion> {
  const { rows } = await client.query<{ id: string; version: number; effective_from: string; config: unknown }>(
    `SELECT id, version, ${DATE('effective_from')} AS effective_from, config FROM mentor_score_configs WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw ApiError.notFound('Scoring configuration');
  return toConfigVersion(rows[0]);
}

/** The newest published version whose effective date is on or before the period start. */
export async function loadConfigForPeriodStart(
  client: PoolClient,
  orgId: string,
  periodStart: string,
): Promise<ConfigVersion> {
  const { rows } = await client.query<{ id: string; version: number; effective_from: string; config: unknown }>(
    `
    SELECT id, version, ${DATE('effective_from')} AS effective_from, config
    FROM mentor_score_configs
    WHERE org_id = $1 AND effective_from <= $2::date
    ORDER BY version DESC LIMIT 1
    `,
    [orgId, periodStart],
  );
  if (!rows[0]) {
    throw ApiError.unprocessable('No scoring configuration is effective for this period; publish one first');
  }
  return toConfigVersion(rows[0]);
}

function toConfigVersion(row: { id: string; version: number; effective_from: string; config: unknown }): ConfigVersion {
  return { id: row.id, version: row.version, effectiveFrom: row.effective_from, config: hydrateConfig(row.config) };
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

interface VisitDbRow {
  id: string;
  mentor_id: string;
  school_id: string;
  started_at: Date;
  ended_at: Date;
  submitted_at: Date;
  completed: boolean;
  assignment_valid: boolean;
  location_status: VisitRecord['location'];
  is_test: boolean;
  cancelled_at: Date | null;
  deleted_at: Date | null;
  spot_applicable: number;
  spot_completed: number;
  inflation_checks: number;
  consistency_checks: number;
}

export function toVisitRecord(row: VisitDbRow): VisitRecord {
  return {
    id: row.id,
    mentorId: row.mentor_id,
    schoolId: row.school_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    submittedAt: row.submitted_at,
    completed: row.completed,
    assignmentValid: row.assignment_valid,
    location: row.location_status,
    isTest: row.is_test,
    isCancelled: row.cancelled_at !== null,
    isDeleted: row.deleted_at !== null,
    spotApplicable: row.spot_applicable,
    spotCompleted: row.spot_completed,
    inflationChecks: row.inflation_checks,
    consistencyChecks: row.consistency_checks,
  };
}

/** Visits whose start falls on a day of the period, in the organisation's timezone. */
export async function loadPeriodVisits(client: PoolClient, orgId: string, period: PeriodRow): Promise<VisitDbRow[]> {
  const { rows } = await client.query<VisitDbRow>(
    `
    SELECT v.id, v.mentor_id, v.school_id, v.started_at, v.ended_at, v.submitted_at, v.completed,
           v.assignment_valid, v.location_status, v.is_test, v.cancelled_at, v.deleted_at,
           v.spot_applicable, v.spot_completed, v.inflation_checks, v.consistency_checks
    FROM mentoring_visits v
    JOIN organizations o ON o.id = v.org_id
    WHERE v.org_id = $1
      AND (v.started_at AT TIME ZONE o.timezone)::date BETWEEN $2::date AND $3::date
    `,
    [orgId, period.start_date, period.end_date],
  );
  return rows;
}

interface FlagDbRow {
  id: string;
  visit_id: string;
  mentor_id: string;
  kind: 'inflation' | 'contradiction';
  status: string;
  visit_in_period: boolean;
  confirmed_at: Date | null;
  carried_into_period_id: string | null;
}

export interface MentorEvidence {
  mentor: MentorRow;
  score: ScoreEvidence;
  result: MentorScoreResult;
  visitIds: string[];
  /** Per-visit assessment, for the evidence screens. */
  assessed: ReturnType<typeof assessVisits>;
  expected: { target: number; activeDays: number; excludedDays: number };
}

interface PeriodData {
  mentors: MentorRow[];
  visitsByMentor: Map<string, VisitDbRow[]>;
  exclusions: { user_id: string | null; start_date: string; end_date: string }[];
  flags: FlagDbRow[];
  unresolvedByMentor: Map<string, number>;
}

async function loadPeriodData(client: PoolClient, period: PeriodRow, orgId: string): Promise<PeriodData> {
  const { rows: mentors } = await client.query<MentorRow>(
    `
    SELECT p.user_id, p.mentor_role, p.district, p.block,
           ${DATE('p.active_from')} AS active_from, ${DATE('p.active_to')} AS active_to
    FROM mentor_profiles p
    JOIN users u ON u.id = p.user_id
    WHERE p.org_id = $1
      AND (p.active_from IS NULL OR p.active_from <= $3::date)
      AND (p.active_to IS NULL OR p.active_to >= $2::date)
    ORDER BY p.user_id
    `,
    [orgId, period.start_date, period.end_date],
  );

  const visits = await loadPeriodVisits(client, orgId, period);
  const visitsByMentor = new Map<string, VisitDbRow[]>();
  for (const visit of visits) {
    const list = visitsByMentor.get(visit.mentor_id) ?? [];
    list.push(visit);
    visitsByMentor.set(visit.mentor_id, list);
  }

  // Approved leave and declared exclusions both come out of the denominator.
  const { rows: exclusions } = await client.query<{ user_id: string | null; start_date: string; end_date: string }>(
    `
    SELECT user_id, ${DATE('start_date')} AS start_date, ${DATE('end_date')} AS end_date
    FROM scoring_exclusions
    WHERE org_id = $1 AND start_date <= $3::date AND end_date >= $2::date
    UNION ALL
    SELECT l.user_id, ${DATE('l.start_date')}, ${DATE('l.end_date')}
    FROM leave_requests l
    JOIN users u ON u.id = l.user_id
    WHERE u.org_id = $1 AND l.status = 'approved' AND l.start_date <= $3::date AND l.end_date >= $2::date
    `,
    [orgId, period.start_date, period.end_date],
  );

  // A flag counts toward this period when it is confirmed and either (a) it
  // sits on one of this period's visits and was confirmed before the period
  // closed, or (b) it was explicitly carried into this period.
  const { rows: flags } = await client.query<FlagDbRow>(
    `
    SELECT f.id, f.visit_id, f.mentor_id, f.kind, f.status, f.confirmed_at, f.carried_into_period_id,
           ((v.started_at AT TIME ZONE o.timezone)::date BETWEEN $2::date AND $3::date) AS visit_in_period
    FROM quality_flags f
    JOIN mentoring_visits v ON v.id = f.visit_id
    JOIN organizations o ON o.id = f.org_id
    WHERE f.org_id = $1
      AND ((v.started_at AT TIME ZONE o.timezone)::date BETWEEN $2::date AND $3::date
           OR f.carried_into_period_id = $4)
    `,
    [orgId, period.start_date, period.end_date, period.id],
  );

  const unresolvedByMentor = new Map<string, number>();
  for (const flag of flags) {
    if (flag.visit_in_period && ['new', 'in_review', 'escalated'].includes(flag.status)) {
      unresolvedByMentor.set(flag.mentor_id, (unresolvedByMentor.get(flag.mentor_id) ?? 0) + 1);
    }
  }
  return { mentors, visitsByMentor, exclusions, flags, unresolvedByMentor };
}

function flagCountsForPeriod(flag: FlagDbRow, period: PeriodRow): boolean {
  if (flag.status !== 'confirmed' || !flag.confirmed_at) return false;
  if (flag.carried_into_period_id === period.id) return true;
  if (!flag.visit_in_period || flag.carried_into_period_id) return false;
  // Open periods have no cut-off yet: anything already confirmed counts.
  return period.closed_at === null || flag.confirmed_at <= period.closed_at;
}

function evaluateMentor(period: PeriodRow, config: MentorScoreConfig, data: PeriodData, mentor: MentorRow): MentorEvidence {
  const range: DateRange = { start: period.start_date, end: period.end_date };
  const exclusionRanges = data.exclusions
    .filter((entry) => entry.user_id === null || entry.user_id === mentor.user_id)
    .map((entry) => ({ start: entry.start_date, end: entry.end_date }));

  const active = activeDays(range, mentor.active_from, mentor.active_to);
  const excused = excludedDays(range, mentor.active_from, mentor.active_to, exclusionRanges);
  const target = roleTarget(config, mentor.mentor_role);
  const expected = expectedVisits({ target, periodDays: config.periodDays, activeDays: active, excludedDays: excused });

  const rows = data.visitsByMentor.get(mentor.user_id) ?? [];
  const assessed = assessVisits(rows.map(toVisitRecord), config);

  // Only flags on visits that were themselves eligible can move the score:
  // a confirmed issue on an ineligible visit has no check in the denominator.
  const eligibleIds = new Set(assessed.assessments.filter((entry) => entry.eligible).map((entry) => entry.visitId));

  const mine = data.flags.filter(
    (flag) =>
      flag.mentor_id === mentor.user_id &&
      flagCountsForPeriod(flag, period) &&
      (!flag.visit_in_period || eligibleIds.has(flag.visit_id)),
  );
  const score: ScoreEvidence = {
    expectedVisits: expected,
    eligibleVisits: assessed.evidence.eligibleVisits,
    durationValidVisits: assessed.evidence.durationValidVisits,
    spotApplicable: assessed.evidence.spotApplicable,
    spotCompleted: assessed.evidence.spotCompleted,
    inflationChecks: assessed.evidence.inflationChecks,
    confirmedInflation: mine.filter((flag) => flag.kind === 'inflation').length,
    consistencyChecks: assessed.evidence.consistencyChecks,
    confirmedContradictions: mine.filter((flag) => flag.kind === 'contradiction').length,
    unresolvedFlags: data.unresolvedByMentor.get(mentor.user_id) ?? 0,
  };

  return {
    mentor,
    score,
    result: computeMentorScore(score, config),
    visitIds: rows.map((row) => row.id),
    assessed,
    expected: { target, activeDays: active, excludedDays: excused },
  };
}

/** Evaluates every mentor in a period without writing anything. */
export async function evaluatePeriod(
  client: PoolClient,
  orgId: string,
  period: PeriodRow,
  config: MentorScoreConfig,
): Promise<MentorEvidence[]> {
  const data = await loadPeriodData(client, period, orgId);
  return data.mentors.map((mentor) => evaluateMentor(period, config, data, mentor));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface StoredScoreSummary {
  overall: number | null;
  compliance: number | null;
  reliability: number | null;
  status: string;
  version: number;
}

function summarise(result: MentorScoreResult, version: number): StoredScoreSummary {
  return {
    overall: result.overall,
    compliance: result.compliance,
    reliability: result.reliability,
    status: result.status,
    version,
  };
}

async function insertScore(
  client: PoolClient,
  orgId: string,
  period: PeriodRow,
  configVersion: ConfigVersion,
  entry: MentorEvidence,
  version: number,
  recalculated: boolean,
): Promise<string> {
  const { result } = entry;
  const { rows } = await client.query<{ id: string }>(
    `
    INSERT INTO mentor_scores
      (org_id, mentor_id, period_id, version, is_current, overall, compliance, reliability, status,
       status_reasons, under_review, evidence_counts, config_version_id, recalculated_at)
    VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
    RETURNING id
    `,
    [
      orgId,
      entry.mentor.user_id,
      period.id,
      version,
      result.overall,
      result.compliance,
      result.reliability,
      result.status,
      result.statusReasons,
      result.underReview,
      JSON.stringify({ ...result.evidence, expected: entry.expected }),
      configVersion.id,
      recalculated ? new Date() : null,
    ],
  );
  const scoreId = rows[0]!.id;
  for (const metric of result.metrics) {
    await client.query(
      `
      INSERT INTO mentor_score_metrics
        (mentor_score_id, metric_code, numerator, denominator, raw_value, weight, effective_weight,
         weighted_value, rule_version, applicability_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        scoreId,
        metric.code,
        metric.numerator,
        metric.denominator,
        metric.rawValue,
        metric.weight,
        metric.effectiveWeight,
        metric.weightedValue,
        configVersion.version,
        metric.applicable ? 'applicable' : 'not_applicable',
      ],
    );
  }
  return scoreId;
}

/**
 * Closes a period: freezes it onto the configuration in force at its start,
 * applies carried-over late confirmations, and snapshots one score per mentor.
 */
export async function closePeriod(
  actor: AuthenticatedActor,
  periodId: string,
  now: Date = new Date(),
): Promise<{ period: PeriodRow; scored: number }> {
  return withTransaction(async (client) => {
    const period = await loadPeriod(client, actor.orgId, periodId, true);
    if (period.status === 'closed') throw ApiError.conflict('This period is already closed');

    const { rows: today } = await client.query<{ today: string }>(
      `SELECT to_char((($1::timestamptz) AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS today FROM organizations o WHERE o.id = $2`,
      [now, actor.orgId],
    );
    if (today[0]!.today <= period.end_date) {
      throw ApiError.unprocessable(`A period cannot close before it has ended (ends ${period.end_date})`);
    }

    const configVersion = await loadConfigForPeriodStart(client, actor.orgId, period.start_date);
    const problems = validateScoreConfig(configVersion.config);
    if (problems.length > 0) throw ApiError.unprocessable('Configuration is invalid', problems);

    await client.query(
      `UPDATE scoring_periods SET status = 'closed', closed_at = $2, config_version_id = $3 WHERE id = $1`,
      [period.id, now, configVersion.id],
    );
    const closed: PeriodRow = { ...period, status: 'closed', closed_at: now, config_version_id: configVersion.id };

    // Carryover: confirmations that landed after an earlier period closed are
    // applied to this one, once.
    if (configVersion.config.lateConfirmationPolicy === 'carryover') {
      await client.query(
        `
        UPDATE quality_flags f
        SET carried_into_period_id = $2
        FROM mentoring_visits v, scoring_periods q, organizations o
        WHERE v.id = f.visit_id AND o.id = f.org_id AND f.org_id = $1
          AND q.org_id = f.org_id AND q.status = 'closed' AND q.id <> $2
          AND q.end_date < $3::date
          AND (v.started_at AT TIME ZONE o.timezone)::date BETWEEN q.start_date AND q.end_date
          AND f.status = 'confirmed' AND f.confirmed_at > q.closed_at
          AND f.carried_into_period_id IS NULL
          AND EXISTS (
            SELECT 1 FROM mentor_profiles p
            WHERE p.user_id = f.mentor_id
              AND (p.active_from IS NULL OR p.active_from <= $4::date)
              AND (p.active_to IS NULL OR p.active_to >= $3::date)
          )
        `,
        [actor.orgId, period.id, period.start_date, period.end_date],
      );
    }

    const entries = await evaluatePeriod(client, actor.orgId, closed, configVersion.config);
    for (const entry of entries) {
      const scoreId = await insertScore(client, actor.orgId, closed, configVersion, entry, 1, false);
      await client.query(
        `
        INSERT INTO score_events (org_id, mentor_id, period_id, event_type, after_value, actor_id, reason)
        VALUES ($1, $2, $3, 'calculated', $4::jsonb, $5, 'Period closed')
        `,
        [actor.orgId, entry.mentor.user_id, period.id, JSON.stringify({ scoreId, ...summarise(entry.result, 1) }), actor.id],
      );
    }

    await snapshotBenchmarks(client, actor.orgId, closed, configVersion.config, entries);
    await recordAudit(
      {
        orgId: actor.orgId,
        actorId: actor.id,
        action: 'mentor_score.period_closed',
        entityType: 'scoring_period',
        entityId: period.id,
        metadata: { scored: entries.length, configVersion: configVersion.version },
      },
      client,
    );
    return { period: closed, scored: entries.length };
  });
}

/** One median per district and role (suppressed when the cohort is small), plus org-wide. */
async function snapshotBenchmarks(
  client: PoolClient,
  orgId: string,
  period: PeriodRow,
  config: MentorScoreConfig,
  entries: MentorEvidence[],
): Promise<void> {
  const scored = entries.filter((entry) => entry.result.overall !== null && entry.result.status !== 'insufficient_data');
  const groups = new Map<string, MentorEvidence[]>();
  for (const entry of scored) {
    for (const geography of [entry.mentor.district ?? '*', '*']) {
      const key = `${geography}\u0000${entry.mentor.mentor_role}`;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
  }
  for (const [key, members] of groups) {
    const [geography, role] = key.split('\u0000') as [string, string];
    const benchmark = benchmarkMedian(members.map((member) => member.result.overall as number), config);
    await client.query(
      `
      INSERT INTO benchmark_snapshots
        (org_id, period_id, geography, mentor_role, cohort_definition, statistic, value, cohort_size, suppressed)
      VALUES ($1, $2, $3, $4, $5::jsonb, 'median', $6, $7, $8)
      ON CONFLICT (period_id, geography, mentor_role) DO NOTHING
      `,
      [
        orgId,
        period.id,
        geography,
        role,
        JSON.stringify({ window: [period.start_date, period.end_date], mentorIds: members.map((m) => m.mentor.user_id) }),
        benchmark.value,
        benchmark.cohortSize,
        benchmark.suppressed,
      ],
    );
  }
}

/**
 * Audited recalculation of one mentor's score for a closed period, on the
 * period's frozen configuration. Late confirmations on that period's visits
 * are applied (and marked, so they cannot be applied again elsewhere). The
 * previous score is kept as a non-current version.
 */
export async function recalculateMentor(
  actor: AuthenticatedActor,
  periodId: string,
  mentorId: string,
  reason: string,
): Promise<{ scoreId: string; version: number; before: StoredScoreSummary; after: StoredScoreSummary }> {
  return withTransaction(async (client) => {
    const period = await loadPeriod(client, actor.orgId, periodId, true);
    if (period.status !== 'closed' || !period.config_version_id) {
      throw ApiError.unprocessable('Only a closed period can be recalculated');
    }
    const configVersion = await loadConfigById(client, period.config_version_id);

    const { rows: current } = await client.query<{ id: string; version: number } & Record<string, unknown>>(
      `SELECT id, version, overall::float8 AS overall, compliance::float8 AS compliance,
              reliability::float8 AS reliability, status
       FROM mentor_scores WHERE mentor_id = $1 AND period_id = $2 AND is_current AND org_id = $3 FOR UPDATE`,
      [mentorId, periodId, actor.orgId],
    );
    if (!current[0]) throw ApiError.notFound('Mentor score');

    await client.query(
      `
      UPDATE quality_flags f
      SET carried_into_period_id = $2
      FROM mentoring_visits v, organizations o
      WHERE v.id = f.visit_id AND o.id = f.org_id AND f.org_id = $1 AND f.mentor_id = $3
        AND (v.started_at AT TIME ZONE o.timezone)::date BETWEEN $4::date AND $5::date
        AND f.status = 'confirmed' AND f.confirmed_at > $6 AND f.carried_into_period_id IS NULL
      `,
      [actor.orgId, period.id, mentorId, period.start_date, period.end_date, period.closed_at],
    );

    const data = await loadPeriodData(client, period, actor.orgId);
    const mentor = data.mentors.find((candidate) => candidate.user_id === mentorId);
    if (!mentor) throw ApiError.notFound('Mentor');
    const entry = evaluateMentor(period, configVersion.config, data, mentor);

    const before: StoredScoreSummary = {
      overall: current[0].overall as number | null,
      compliance: current[0].compliance as number | null,
      reliability: current[0].reliability as number | null,
      status: current[0].status as string,
      version: current[0].version,
    };
    const version = current[0].version + 1;
    await client.query(`UPDATE mentor_scores SET is_current = FALSE WHERE id = $1`, [current[0].id]);
    const scoreId = await insertScore(client, actor.orgId, period, configVersion, entry, version, true);
    const after = summarise(entry.result, version);

    await client.query(
      `
      INSERT INTO score_events (org_id, mentor_id, period_id, event_type, before_value, after_value, actor_id, reason)
      VALUES ($1, $2, $3, 'recalculated', $4::jsonb, $5::jsonb, $6, $7)
      `,
      [actor.orgId, mentorId, periodId, JSON.stringify(before), JSON.stringify({ scoreId, ...after }), actor.id, reason],
    );
    await recordAudit(
      {
        orgId: actor.orgId,
        actorId: actor.id,
        action: 'mentor_score.recalculated',
        entityType: 'mentor_score',
        entityId: scoreId,
        metadata: { mentorId, periodId, reason, before, after },
      },
      client,
    );
    return { scoreId, version, before, after };
  });
}
