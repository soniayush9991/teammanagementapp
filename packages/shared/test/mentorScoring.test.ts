import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SCORE_CONFIG,
  activeDays,
  assessVisit,
  assessVisits,
  benchmarkMedian,
  computeMentorScore,
  excludedDays,
  expectedVisits,
  primaryAction,
  selectNudges,
  selectRecognition,
  validateScoreConfig,
  type MentorScoreConfig,
  type RecognitionCandidate,
  type ScoreEvidence,
  type VisitRecord,
} from '../src/mentorScoring.ts';

const config: MentorScoreConfig = DEFAULT_SCORE_CONFIG;

function evidence(overrides: Partial<ScoreEvidence> = {}): ScoreEvidence {
  return {
    expectedVisits: 15,
    eligibleVisits: 15,
    durationValidVisits: 15,
    spotApplicable: 10,
    spotCompleted: 10,
    inflationChecks: 25,
    confirmedInflation: 0,
    consistencyChecks: 30,
    confirmedContradictions: 0,
    ...overrides,
  };
}

function visit(overrides: Partial<VisitRecord> = {}): VisitRecord {
  return {
    id: 'v1',
    mentorId: 'm1',
    schoolId: 's1',
    startedAt: '2026-09-01T09:00:00Z',
    endedAt: '2026-09-01T09:45:00Z',
    completed: true,
    assignmentValid: true,
    location: 'verified',
    ...overrides,
  };
}

const metric = (result: ReturnType<typeof computeMentorScore>, code: string) =>
  result.metrics.find((entry) => entry.code === code)!;

// --- PRD Appendix A ---------------------------------------------------------

test('Appendix A: the worked example reproduces to two decimals', () => {
  const result = computeMentorScore(
    evidence({
      eligibleVisits: 13,
      durationValidVisits: 12,
      spotApplicable: 10,
      spotCompleted: 8,
      inflationChecks: 25,
      confirmedInflation: 1,
      consistencyChecks: 30,
      confirmedContradictions: 2,
    }),
    config,
  );
  assert.equal(metric(result, 'visit_coverage').rawValue, 86.67);
  assert.equal(metric(result, 'duration_validity').rawValue, 92.31);
  assert.equal(metric(result, 'spot_completion').rawValue, 80);
  assert.equal(metric(result, 'inflation_reliability').rawValue, 96);
  assert.equal(metric(result, 'contradiction_reliability').rawValue, 93.33);
  // The PRD prints compliance 86.20 / overall 91.28, but its own inputs give
  // 0.6*86.67 + 0.2*92.31 + 0.2*80 = 86.46. Displayed overall is 91 either way.
  assert.equal(result.compliance, 86.46);
  assert.equal(result.reliability, 94.67);
  assert.equal(result.overall, 91.38);
  assert.equal(Math.round(result.overall!), 91);
  assert.equal(result.status, 'final');
});

test('weighted values sum to the overall score', () => {
  const result = computeMentorScore(evidence({ eligibleVisits: 13, durationValidVisits: 12, spotCompleted: 8, confirmedInflation: 1, confirmedContradictions: 2 }), config);
  const total = result.metrics.reduce((sum, entry) => sum + entry.weightedValue, 0);
  assert.ok(Math.abs(total - result.overall!) < 0.03, `${total} vs ${result.overall}`);
  assert.equal(metric(result, 'visit_coverage').effectiveWeight, 0.24);
});

// --- Appendix B -------------------------------------------------------------

test('T01/T02: coverage is eligible over expected, capped at 100', () => {
  assert.equal(metric(computeMentorScore(evidence(), config), 'visit_coverage').rawValue, 100);
  assert.equal(metric(computeMentorScore(evidence({ eligibleVisits: 10, durationValidVisits: 10 }), config), 'visit_coverage').rawValue, 66.67);
  // Very active mentor: 30 visits against a target of 15 earns no extra.
  const busy = computeMentorScore(evidence({ eligibleVisits: 30, durationValidVisits: 30 }), config);
  assert.equal(metric(busy, 'visit_coverage').rawValue, 100);
  assert.equal(busy.overall, 100);
});

test('T03: approved leave prorates the expected visits', () => {
  const period = { start: '2026-09-01', end: '2026-09-14' };
  const active = activeDays(period, null, null);
  const leave = excludedDays(period, null, null, [{ start: '2026-09-03', end: '2026-09-05' }]);
  assert.equal(active, 14);
  assert.equal(leave, 3);
  assert.equal(expectedVisits({ target: 14, periodDays: 14, activeDays: active, excludedDays: leave }), 11);
});

test('overlapping exclusions are not subtracted twice', () => {
  const period = { start: '2026-09-01', end: '2026-09-14' };
  const days = excludedDays(period, null, null, [
    { start: '2026-09-03', end: '2026-09-06' },
    { start: '2026-09-05', end: '2026-09-08' },
    { start: '2026-08-20', end: '2026-09-02' },
  ]);
  assert.equal(days, 8); // 1-8 September
});

test('exclusions outside the active window do not count', () => {
  const period = { start: '2026-09-01', end: '2026-09-14' };
  // Mentor joined on the 8th: leave on the 3rd was never their working time.
  assert.equal(activeDays(period, '2026-09-08', null), 7);
  assert.equal(excludedDays(period, '2026-09-08', null, [{ start: '2026-09-03', end: '2026-09-04' }]), 0);
  assert.equal(expectedVisits({ target: 14, periodDays: 14, activeDays: 7, excludedDays: 0 }), 7);
});

test('a fully excused period has nothing expected, so coverage is not applicable', () => {
  const result = computeMentorScore(evidence({ expectedVisits: 0, eligibleVisits: 0, durationValidVisits: 0, spotApplicable: 0, spotCompleted: 0 }), config);
  assert.equal(metric(result, 'visit_coverage').applicable, false);
  assert.equal(result.status, 'insufficient_data');
});

test('T04/T13: retries and offline re-syncs contribute once', () => {
  const retried = [visit({ id: 'a' }), visit({ id: 'a' }), visit({ id: 'a', submittedAt: '2026-09-02T00:00:00Z' })];
  const assessed = assessVisits(retried, config);
  assert.equal(assessed.evidence.eligibleVisits, 1);
  assert.equal(assessed.duplicates.length, 2);
});

test('a second visit to the same school inside the window is a duplicate; later or elsewhere is not', () => {
  const visits = [
    visit({ id: 'a' }),
    visit({ id: 'b', startedAt: '2026-09-01T10:00:00Z', endedAt: '2026-09-01T10:40:00Z' }),
    visit({ id: 'c', schoolId: 's2', startedAt: '2026-09-01T10:00:00Z', endedAt: '2026-09-01T10:40:00Z' }),
    visit({ id: 'd', startedAt: '2026-09-08T09:00:00Z', endedAt: '2026-09-08T09:40:00Z' }),
  ];
  const assessed = assessVisits(visits, config);
  assert.equal(assessed.evidence.eligibleVisits, 3);
  assert.deepEqual(assessed.duplicates.map((entry) => entry.visit.id), ['b']);
});

test('an abandoned attempt never absorbs the real visit that follows it', () => {
  const visits = [
    visit({ id: 'draft', completed: false, endedAt: '2026-09-01T09:05:00Z' }),
    visit({ id: 'real', startedAt: '2026-09-01T09:30:00Z', endedAt: '2026-09-01T10:15:00Z' }),
    visit({ id: 'gone', startedAt: '2026-09-01T08:50:00Z', endedAt: '2026-09-01T09:40:00Z', isDeleted: true }),
  ];
  const assessed = assessVisits(visits, config);
  assert.equal(assessed.evidence.eligibleVisits, 1);
  assert.equal(assessed.duplicates.length, 0);
});

test('deduplication does not depend on input order', () => {
  const visits = [
    visit({ id: 'b', startedAt: '2026-09-01T10:00:00Z', endedAt: '2026-09-01T10:40:00Z' }),
    visit({ id: 'a' }),
  ];
  assert.deepEqual(assessVisits(visits, config).duplicates.map((d) => d.visit.id), ['b']);
  assert.deepEqual(assessVisits([...visits].reverse(), config).duplicates.map((d) => d.visit.id), ['b']);
});

test('T05: time beyond the duration cap earns nothing extra', () => {
  const long = assessVisit(visit({ endedAt: '2026-09-01T10:30:00Z' }), config);
  assert.equal(long.durationMinutes, 90);
  assert.equal(long.scoredDurationMinutes, 60);
  assert.equal(long.durationValid, true);
  const short = assessVisit(visit({ endedAt: '2026-09-01T09:20:00Z' }), config);
  assert.equal(short.durationValid, false);
  assert.equal(short.eligible, true);
});

test('T06: non-applicable spot assessments are excluded and weights rescale', () => {
  const result = computeMentorScore(evidence({ spotApplicable: 0, spotCompleted: 0, durationValidVisits: 10 }), config);
  assert.equal(metric(result, 'spot_completion').applicable, false);
  assert.equal(metric(result, 'spot_completion').effectiveWeight, 0);
  // coverage 100 @ .75, duration 66.67 @ .25 => 91.67
  assert.equal(result.compliance, 91.67);
  const weights = result.metrics.reduce((sum, entry) => sum + entry.effectiveWeight, 0);
  assert.ok(Math.abs(weights - 1) < 0.011);
});

test('T07/T14: flagged-but-unconfirmed and negative findings carry no penalty', () => {
  const clean = computeMentorScore(evidence(), config);
  const flagged = computeMentorScore(evidence({ unresolvedFlags: 3 }), config);
  assert.equal(flagged.overall, clean.overall);
  assert.equal(flagged.underReview, true);
  assert.equal(clean.underReview, false);
});

test('T08: a confirmed issue lowers only its own reliability metric', () => {
  const result = computeMentorScore(evidence({ confirmedContradictions: 3 }), config);
  assert.equal(metric(result, 'contradiction_reliability').rawValue, 90);
  assert.equal(metric(result, 'inflation_reliability').rawValue, 100);
  assert.equal(result.reliability, 95);
  assert.equal(result.overall, 97);
});

test('T10: thin evidence is provisional; none at all is insufficient data', () => {
  const thin = computeMentorScore(evidence({ expectedVisits: 3, eligibleVisits: 3, durationValidVisits: 3 }), config);
  assert.equal(thin.status, 'provisional');
  assert.deepEqual(thin.statusReasons, ['below_minimum_visits']);
  assert.notEqual(thin.overall, null);

  const fewChecks = computeMentorScore(evidence({ inflationChecks: 5, consistencyChecks: 5 }), config);
  assert.equal(fewChecks.status, 'provisional');
  assert.deepEqual(fewChecks.statusReasons, ['below_minimum_checks']);

  const none = computeMentorScore(evidence({ eligibleVisits: 0, durationValidVisits: 0, spotApplicable: 0, spotCompleted: 0 }), config);
  assert.equal(none.status, 'insufficient_data');
  assert.equal(none.overall, null);
  assert.deepEqual(none.statusReasons.slice(0, 1), ['no_eligible_visits']);
});

test('visits without any quality checks cannot be scored on reliability', () => {
  const result = computeMentorScore(evidence({ inflationChecks: 0, consistencyChecks: 0 }), config);
  assert.equal(result.reliability, null);
  assert.equal(result.overall, null);
  assert.equal(result.status, 'insufficient_data');
  assert.ok(result.statusReasons.includes('no_quality_checks'));
});

test('one reliability metric may be not applicable without losing the component', () => {
  const result = computeMentorScore(evidence({ inflationChecks: 0, consistencyChecks: 30, confirmedContradictions: 3 }), config);
  assert.equal(metric(result, 'inflation_reliability').applicable, false);
  assert.equal(result.reliability, 90);
});

test('numerators are clamped to their denominators and nothing divides by zero', () => {
  const result = computeMentorScore(
    evidence({ durationValidVisits: 99, spotCompleted: 99, confirmedInflation: 999, confirmedContradictions: 999 }),
    config,
  );
  assert.equal(metric(result, 'duration_validity').rawValue, 100);
  assert.equal(metric(result, 'spot_completion').rawValue, 100);
  assert.equal(metric(result, 'inflation_reliability').rawValue, 0);
  assert.equal(result.reliability, 0);
  for (const entry of result.metrics) assert.ok(Number.isFinite(entry.weightedValue));
});

test('T09/T11: the result depends only on evidence and the config it is given', () => {
  const base = computeMentorScore(evidence({ confirmedContradictions: 3 }), config);
  const repeat = computeMentorScore(evidence({ confirmedContradictions: 3 }), config);
  assert.deepEqual(repeat, base);

  const reweighted: MentorScoreConfig = {
    ...config,
    componentWeights: { compliance: 0.5, reliability: 0.5 },
  };
  assert.notEqual(computeMentorScore(evidence({ confirmedContradictions: 3, eligibleVisits: 10, durationValidVisits: 10 }), reweighted).overall,
    computeMentorScore(evidence({ confirmedContradictions: 3, eligibleVisits: 10, durationValidVisits: 10 }), config).overall);
  // The original config object is untouched, so a closed score recomputes the same.
  assert.deepEqual(computeMentorScore(evidence({ confirmedContradictions: 3 }), config), base);
});

// --- Visit validation -------------------------------------------------------

test('visit validation reports every failing check', () => {
  const bad = assessVisit(
    visit({ assignmentValid: false, completed: false, location: 'failed', isTest: true, endedAt: '2026-09-01T08:00:00Z' }),
    config,
  );
  assert.equal(bad.eligible, false);
  assert.deepEqual(bad.reasons, ['invalid_assignment', 'invalid_timestamps', 'location_unverified', 'incomplete', 'system_record']);
  assert.equal(bad.durationMinutes, null);
});

test('an accepted GPS exception is eligible; unverified depends on configuration', () => {
  assert.equal(assessVisit(visit({ location: 'exception' }), config).eligible, true);
  assert.equal(assessVisit(visit({ location: 'unverified' }), config).eligible, false);
  assert.equal(assessVisit(visit({ location: 'unverified' }), { ...config, requireVerifiedLocation: false }).eligible, true);
});

test('only eligible visits contribute spot and quality-check counts', () => {
  const assessed = assessVisits(
    [
      visit({ id: 'ok', spotApplicable: 2, spotCompleted: 5, inflationChecks: 4, consistencyChecks: 6 }),
      visit({ id: 'bad', schoolId: 's2', completed: false, spotApplicable: 9, spotCompleted: 9, inflationChecks: 9, consistencyChecks: 9 }),
    ],
    config,
  );
  assert.deepEqual(assessed.evidence, {
    eligibleVisits: 1,
    durationValidVisits: 1,
    spotApplicable: 2,
    spotCompleted: 2,
    inflationChecks: 4,
    consistencyChecks: 6,
  });
});

// --- Config -----------------------------------------------------------------

test('default configuration is valid; broken weights are rejected', () => {
  assert.deepEqual(validateScoreConfig(config), []);
  const problems = validateScoreConfig({ ...config, componentWeights: { compliance: 0.5, reliability: 0.6 } });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /componentWeights must sum to 100%/);
  assert.ok(validateScoreConfig({ ...config, durationCapMinutes: 10 }).some((p) => p.includes('durationCapMinutes')));
});

// --- Benchmarks, nudges, recognition -----------------------------------------

test('benchmark is a median and is suppressed for small cohorts', () => {
  assert.deepEqual(benchmarkMedian([60, 70, 80, 90, 100], config), { statistic: 'median', value: 80, cohortSize: 5, suppressed: false });
  assert.deepEqual(benchmarkMedian([60, 70, 80, 99], config), { statistic: 'median', value: null, cohortSize: 4, suppressed: true });
  // One extreme score does not move a median.
  assert.equal(benchmarkMedian([60, 70, 80, 90, 1000], config).value, 80);
});

test('nudges target the biggest driver and never mention rank', () => {
  const result = computeMentorScore(evidence({ eligibleVisits: 12, durationValidVisits: 12, confirmedContradictions: 12 }), config);
  const nudges = selectNudges(result, 70);
  assert.equal(nudges[0]!.code, 'confirmed_contradiction');
  assert.ok(nudges.some((n) => n.code === 'coverage_low' && n.params.percent === 80));
  assert.equal(nudges.at(-1)!.code, 'most_improved');
  assert.equal(primaryAction(result)!.code, 'confirmed_contradiction');
  for (const nudge of nudges) assert.doesNotMatch(nudge.message, /underperform|worst|rank|bottom/i);
  assert.deepEqual(selectNudges(computeMentorScore(evidence({ eligibleVisits: 0, durationValidVisits: 0 }), config)), []);
  assert.equal(primaryAction(computeMentorScore(evidence(), config)), null);
});

test('recognition requires a final score, the quality floor, and a clean record', () => {
  const base = { status: 'final', underReview: false, previousOverall: 80 } as const;
  const candidates: RecognitionCandidate[] = [
    { ...base, mentorId: 'a', overall: 95, compliance: 90, reliability: 97 },
    { ...base, mentorId: 'b', overall: 99, compliance: 100, reliability: 70 }, // below the floor
    { ...base, mentorId: 'c', overall: 92, compliance: 99, reliability: 92, previousOverall: 60 },
    { ...base, mentorId: 'd', overall: 98, compliance: 98, reliability: 98, underReview: true },
    { ...base, mentorId: 'e', overall: 99, compliance: 99, reliability: 99, status: 'provisional' },
  ];
  assert.deepEqual(selectRecognition(candidates, config), {
    top_overall: ['a'],
    most_improved: ['c'],
    reliable_data: ['a'],
    strong_coverage: ['c'],
  });
});

test('recognition ties return every tied mentor and never invents a winner', () => {
  const base = { status: 'final', underReview: false, previousOverall: null, compliance: 90, reliability: 90 } as const;
  const result = selectRecognition(
    [
      { ...base, mentorId: 'b', overall: 90 },
      { ...base, mentorId: 'a', overall: 90 },
    ],
    config,
  );
  assert.deepEqual(result.top_overall, ['a', 'b']);
  assert.deepEqual(result.most_improved, []);
});
