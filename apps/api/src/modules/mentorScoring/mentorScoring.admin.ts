import {
  selectRecognition,
  type MentorScoreResult,
  type RecognitionCandidate,
  type RecognitionCategory,
} from '@teamspace/shared';
import { queryOne, queryRows, withTransaction } from '../../db/pool.js';
import { ApiError } from '../../lib/errors.js';
import type { AuthenticatedActor } from '../../middleware/auth.js';
import { DATE, hydrateConfig, loadConfigById, loadConfigForPeriodStart, type PeriodRow } from './mentorScoring.calc.js';
import { assertMentorInScope, mentorScope, periodForAdmin } from './mentorScoring.service.js';

/** Districts, blocks and roles the actor can filter by, drawn from mentors they may see. */
export async function getFilterOptions(actor: AuthenticatedActor) {
  const params: unknown[] = [actor.orgId];
  const scope = mentorScope(actor, 'p.user_id', params);
  const rows = await queryRows<{ district: string | null; block: string | null; mentor_role: string }>(
    `SELECT DISTINCT p.district, p.block, p.mentor_role FROM mentor_profiles p WHERE p.org_id = $1 AND ${scope}`,
    params,
  );
  const unique = <T>(values: (T | null)[]): T[] => [...new Set(values.filter((v): v is T => v !== null))].sort() as T[];
  return {
    districts: unique(rows.map((row) => row.district)),
    blocks: rows
      .filter((row) => row.block !== null)
      .map((row) => ({ block: row.block as string, district: row.district }))
      .filter((entry, index, all) => all.findIndex((other) => other.block === entry.block && other.district === entry.district) === index)
      .sort((a, b) => a.block.localeCompare(b.block)),
    roles: unique(rows.map((row) => row.mentor_role)),
  };
}

export interface ProfileFilter {
  district?: string;
  block?: string;
  role?: string;
}

/** SQL limiting `column` (a mentor user id) to mentors matching the profile filters. */
function profileClause(column: string, filter: ProfileFilter, params: unknown[]): string {
  const parts: string[] = [];
  for (const [field, value] of [['district', filter.district], ['block', filter.block], ['mentor_role', filter.role]] as const) {
    if (value) {
      params.push(value);
      parts.push(`pf.${field} = $${params.length}`);
    }
  }
  return parts.length ? `${column} IN (SELECT pf.user_id FROM mentor_profiles pf WHERE ${parts.join(' AND ')})` : 'TRUE';
}

const average = (value: number | null): number | null => (value === null ? null : Math.round(value * 100) / 100);

/**
 * A1: per-period aggregates for the last N closed periods (oldest first), with
 * compliance and reliability kept separate and integrity issues split into
 * confirmed versus still flagged, per kind.
 */
export async function getOverviewTrend(actor: AuthenticatedActor, periodCount: number, filter: ProfileFilter = {}) {
  const params: unknown[] = [actor.orgId, periodCount];
  const scope = `${mentorScope(actor, 's.mentor_id', params)} AND ${profileClause('s.mentor_id', filter, params)}`;
  const rows = await queryRows<{
    period_id: string;
    start_date: string;
    end_date: string;
    mentors: number;
    scored: number;
    final_count: number;
    compliance: number | null;
    reliability: number | null;
    overall: number | null;
    expected: number | null;
    covered: number | null;
    inflation_checks: number | null;
    inflation_confirmed: number | null;
    consistency_checks: number | null;
    contradictions_confirmed: number | null;
  }>(
    `
    WITH recent AS (
      SELECT id, start_date, end_date FROM scoring_periods
      WHERE org_id = $1 AND status = 'closed' ORDER BY start_date DESC LIMIT $2
    )
    SELECT r.id AS period_id, ${DATE('r.start_date')} AS start_date, ${DATE('r.end_date')} AS end_date,
           count(s.id)::int AS mentors,
           count(s.overall)::int AS scored,
           count(*) FILTER (WHERE s.status = 'final')::int AS final_count,
           avg(s.compliance)::float8 AS compliance, avg(s.reliability)::float8 AS reliability, avg(s.overall)::float8 AS overall,
           sum((s.evidence_counts->>'expectedVisits')::numeric)::float8 AS expected,
           sum(LEAST((s.evidence_counts->>'eligibleVisits')::numeric, (s.evidence_counts->>'expectedVisits')::numeric))::float8 AS covered,
           sum((s.evidence_counts->>'inflationChecks')::numeric)::float8 AS inflation_checks,
           sum((s.evidence_counts->>'confirmedInflation')::numeric)::float8 AS inflation_confirmed,
           sum((s.evidence_counts->>'consistencyChecks')::numeric)::float8 AS consistency_checks,
           sum((s.evidence_counts->>'confirmedContradictions')::numeric)::float8 AS contradictions_confirmed
    FROM recent r
    LEFT JOIN mentor_scores s ON s.period_id = r.id AND s.is_current AND ${scope}
    GROUP BY r.id, r.start_date, r.end_date
    ORDER BY r.start_date
    `,
    params,
  );

  const flagParams: unknown[] = [rows.map((row) => row.period_id)];
  const flagScope = `${mentorScope(actor, 'f.mentor_id', flagParams)} AND ${profileClause('f.mentor_id', filter, flagParams)}`;
  const flagRows = rows.length
    ? await queryRows<{ period_id: string; kind: 'inflation' | 'contradiction'; status: string; n: number }>(
        `
        SELECT p.id AS period_id, f.kind, f.status, count(*)::int AS n
        FROM scoring_periods p
        JOIN organizations o ON o.id = p.org_id
        JOIN mentoring_visits v ON v.org_id = p.org_id AND (v.started_at AT TIME ZONE o.timezone)::date BETWEEN p.start_date AND p.end_date
        JOIN quality_flags f ON f.visit_id = v.id
        WHERE p.id = ANY($1::uuid[]) AND ${flagScope}
        GROUP BY p.id, f.kind, f.status
        `,
        flagParams,
      )
    : [];

  const counts = (periodId: string, kind: 'inflation' | 'contradiction') => {
    const mine = flagRows.filter((row) => row.period_id === periodId && row.kind === kind);
    const sum = (statuses: string[]) => mine.filter((row) => statuses.includes(row.status)).reduce((total, row) => total + row.n, 0);
    return { flagged: sum(['new', 'in_review', 'escalated']), confirmed: sum(['confirmed']), dismissed: sum(['dismissed']) };
  };
  const rate = (confirmed: number | null, checks: number | null) =>
    checks && checks > 0 ? Math.round(((confirmed ?? 0) / checks) * 10000) / 100 : null;

  return {
    items: rows.map((row) => ({
      periodId: row.period_id,
      startDate: row.start_date,
      endDate: row.end_date,
      mentors: row.mentors,
      scored: row.scored,
      percentFinal: row.mentors ? Math.round((row.final_count / row.mentors) * 1000) / 10 : null,
      compliance: average(row.compliance),
      reliability: average(row.reliability),
      overall: average(row.overall),
      coverage: row.expected && row.expected > 0 ? Math.round(((row.covered ?? 0) / row.expected) * 1000) / 10 : null,
      inflation: { ...counts(row.period_id, 'inflation'), checks: row.inflation_checks ?? 0, rate: rate(row.inflation_confirmed, row.inflation_checks) },
      contradiction: {
        ...counts(row.period_id, 'contradiction'),
        checks: row.consistency_checks ?? 0,
        rate: rate(row.contradictions_confirmed, row.consistency_checks),
      },
    })),
  };
}

/** A4 evidence pane: the visit, its validation, the rule's explanation, and the review history. */
export async function getFlagDetail(actor: AuthenticatedActor, flagId: string) {
  const flag = await queryOne<{
    id: string;
    mentor_id: string;
    visit_id: string;
    kind: string;
    rule_code: string;
    severity: string;
    status: string;
    explanation: string;
    evidence_payload: Record<string, unknown>;
    created_at: Date;
    confirmed_at: Date | null;
    resolved_at: Date | null;
    carried_into_period_id: string | null;
  }>(
    `SELECT id, mentor_id, visit_id, kind, rule_code, severity, status, explanation, evidence_payload,
            created_at, confirmed_at, resolved_at, carried_into_period_id
     FROM quality_flags WHERE id = $1 AND org_id = $2`,
    [flagId, actor.orgId],
  );
  if (!flag) throw ApiError.notFound('Flag');
  await assertMentorInScope(actor, flag.mentor_id);

  const [visit, mentor, reviews, siblings, repeats] = await Promise.all([
    queryOne(
      `SELECT id, school_id, visit_type, started_at, ended_at, submitted_at, completed, assignment_valid, location_status,
              spot_applicable, spot_completed, inflation_checks, consistency_checks,
              EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0 AS duration_minutes
       FROM mentoring_visits WHERE id = $1`,
      [flag.visit_id],
    ),
    queryOne(
      `SELECT u.id, u.display_name AS name, mp.mentor_role AS role, mp.district, mp.block
       FROM users u LEFT JOIN mentor_profiles mp ON mp.user_id = u.id WHERE u.id = $1`,
      [flag.mentor_id],
    ),
    queryRows(
      `SELECT r.id, r.decision, r.from_status, r.to_status, r.reason_code, r.note, r.decided_at, u.display_name AS reviewer
       FROM audit_reviews r LEFT JOIN users u ON u.id = r.reviewer_id WHERE r.flag_id = $1 ORDER BY r.decided_at, r.id`,
      [flagId],
    ),
    queryRows(
      `SELECT id, kind, rule_code, status FROM quality_flags WHERE visit_id = $1 AND id <> $2 ORDER BY created_at`,
      [flag.visit_id, flagId],
    ),
    queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM quality_flags
       WHERE mentor_id = $1 AND rule_code = $2 AND id <> $3 AND created_at > $4::timestamptz - INTERVAL '60 days'`,
      [flag.mentor_id, flag.rule_code, flagId, flag.created_at],
    ),
  ]);

  return {
    flag: {
      id: flag.id,
      kind: flag.kind,
      ruleCode: flag.rule_code,
      severity: flag.severity,
      status: flag.status,
      explanation: flag.explanation,
      evidence: flag.evidence_payload,
      createdAt: flag.created_at,
      confirmedAt: flag.confirmed_at,
      resolvedAt: flag.resolved_at,
      lateConfirmed: flag.carried_into_period_id !== null,
      repeatCount: repeats?.n ?? 0,
      canReview: flag.mentor_id !== actor.id,
    },
    mentor,
    visit,
    otherFlagsOnVisit: siblings,
    reviews,
  };
}

/** A6: the frozen benchmark snapshots for a period. Member lists are admin-only. */
export async function listBenchmarks(actor: AuthenticatedActor, periodId?: string) {
  const period = await periodForAdmin(actor.orgId, periodId);
  const rows = await queryRows<{
    id: string;
    geography: string;
    mentor_role: string;
    cohort_definition: { window?: string[]; mentorIds?: string[] };
    statistic: string;
    value: number | null;
    cohort_size: number;
    suppressed: boolean;
    cap_method: string;
    created_at: Date;
  }>(
    `SELECT id, geography, mentor_role, cohort_definition, statistic, value::float8 AS value, cohort_size, suppressed, cap_method, created_at
     FROM benchmark_snapshots WHERE period_id = $1 AND org_id = $2 ORDER BY geography = '*' DESC, geography, mentor_role`,
    [period.id, actor.orgId],
  );

  const isAdmin = actor.role === 'admin';
  const memberIds = isAdmin ? [...new Set(rows.flatMap((row) => row.cohort_definition.mentorIds ?? []))] : [];
  const names = new Map(
    memberIds.length
      ? (await queryRows<{ id: string; display_name: string }>(`SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`, [memberIds])).map(
          (row) => [row.id, row.display_name] as const,
        )
      : [],
  );

  const config = period.config_version_id
    ? (await withTransaction((client) => loadConfigById(client, period.config_version_id as string))).config
    : null;

  return {
    period: { id: period.id, startDate: period.start_date, endDate: period.end_date, status: period.status },
    minCohortSize: config?.benchmarkMinCohort ?? null,
    items: rows.map((row) => ({
      id: row.id,
      geography: row.geography === '*' ? 'All districts' : row.geography,
      role: row.mentor_role,
      statistic: row.statistic,
      value: row.value,
      cohortSize: row.cohort_size,
      suppressed: row.suppressed,
      capMethod: row.cap_method,
      dataWindow: row.cohort_definition.window ?? null,
      calculatedAt: row.created_at,
      members: isAdmin ? (row.cohort_definition.mentorIds ?? []).map((id) => ({ id, name: names.get(id) ?? 'Unknown' })) : null,
    })),
  };
}

const CATEGORY_LABEL: Record<RecognitionCategory, string> = {
  top_overall: 'Top overall',
  most_improved: 'Most improved',
  reliable_data: 'Reliable data',
  strong_coverage: 'Strong coverage',
};

/**
 * A7: recognition winners for a closed period. Only positive categories are
 * produced; ineligible mentors are counted by reason but never named, so the
 * screen cannot double as a list of low performers.
 */
export async function getRecognition(actor: AuthenticatedActor, periodId?: string) {
  const period: PeriodRow = await periodForAdmin(actor.orgId, periodId);
  if (period.status !== 'closed') throw ApiError.unprocessable('Recognition is available once a period has been closed');

  const config = period.config_version_id
    ? (await withTransaction((client) => loadConfigById(client, period.config_version_id as string))).config
    : (await withTransaction((client) => loadConfigForPeriodStart(client, actor.orgId, period.start_date))).config;

  const params: unknown[] = [actor.orgId, period.id, period.start_date];
  const scope = mentorScope(actor, 's.mentor_id', params);
  const rows = await queryRows<{
    mentor_id: string;
    name: string;
    district: string | null;
    status: MentorScoreResult['status'];
    overall: number | null;
    compliance: number | null;
    reliability: number | null;
    under_review: boolean;
    previous_overall: number | null;
  }>(
    `
    SELECT s.mentor_id, u.display_name AS name, mp.district, s.status, s.overall::float8 AS overall,
           s.compliance::float8 AS compliance, s.reliability::float8 AS reliability, s.under_review,
           (SELECT ps.overall::float8 FROM mentor_scores ps JOIN scoring_periods pp ON pp.id = ps.period_id
             WHERE ps.mentor_id = s.mentor_id AND ps.is_current AND ps.status = 'final'
               AND pp.status = 'closed' AND pp.start_date < $3::date
             ORDER BY pp.start_date DESC LIMIT 1) AS previous_overall
    FROM mentor_scores s
    JOIN users u ON u.id = s.mentor_id
    LEFT JOIN mentor_profiles mp ON mp.user_id = s.mentor_id
    WHERE s.org_id = $1 AND s.period_id = $2 AND s.is_current AND ${scope}
    `,
    params,
  );

  const candidates: RecognitionCandidate[] = rows.map((row) => ({
    mentorId: row.mentor_id,
    status: row.status,
    overall: row.overall,
    compliance: row.compliance,
    reliability: row.reliability,
    underReview: row.under_review,
    previousOverall: row.previous_overall,
  }));
  const winners = selectRecognition(candidates, config);
  const byId = new Map(rows.map((row) => [row.mentor_id, row]));

  const eligible = rows.filter(
    (row) => row.status === 'final' && !row.under_review && row.reliability !== null && row.reliability >= config.recognitionQualityFloor,
  ).length;

  return {
    period: { id: period.id, startDate: period.start_date, endDate: period.end_date, published: period.published_at !== null },
    qualityFloor: config.recognitionQualityFloor,
    mentorsConsidered: rows.length,
    eligible,
    // Counts only: nobody is named for being ineligible.
    notEligible: {
      notFinal: rows.filter((row) => row.status !== 'final').length,
      openReview: rows.filter((row) => row.status === 'final' && row.under_review).length,
      belowQualityFloor: rows.filter(
        (row) => row.status === 'final' && !row.under_review && (row.reliability ?? 0) < config.recognitionQualityFloor,
      ).length,
    },
    categories: (Object.keys(CATEGORY_LABEL) as RecognitionCategory[]).map((category) => ({
      category,
      label: CATEGORY_LABEL[category],
      winners: winners[category].map((id) => {
        const row = byId.get(id)!;
        const value =
          category === 'top_overall' ? row.overall
          : category === 'reliable_data' ? row.reliability
          : category === 'strong_coverage' ? row.compliance
          : row.overall !== null && row.previous_overall !== null ? Math.round(row.overall) - Math.round(row.previous_overall)
          : null;
        return { mentorId: id, name: row.name, district: row.district, value };
      }),
    })),
  };
}

/** A5: every published configuration version, newest first. */
export async function listConfigVersions(actor: AuthenticatedActor) {
  const rows = await queryRows<{
    id: string;
    version: number;
    effective_from: string;
    note: string | null;
    created_at: Date;
    created_by_name: string | null;
    config: unknown;
  }>(
    `SELECT c.id, c.version, ${DATE('c.effective_from')} AS effective_from, c.note, c.created_at,
            u.display_name AS created_by_name, c.config
     FROM mentor_score_configs c LEFT JOIN users u ON u.id = c.created_by
     WHERE c.org_id = $1 ORDER BY c.version DESC`,
    [actor.orgId],
  );
  return {
    items: rows.map((row) => ({
      id: row.id,
      version: row.version,
      effectiveFrom: row.effective_from,
      note: row.note,
      createdAt: row.created_at,
      createdBy: row.created_by_name,
      config: hydrateConfig(row.config),
    })),
  };
}
