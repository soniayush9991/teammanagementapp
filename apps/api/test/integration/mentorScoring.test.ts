import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_SCORE_CONFIG } from '@teamspace/shared';
import { api, canRunIntegrationTests, DEMO, login, startTestServer, type TestContext } from './harness.ts';

interface ReportCard {
  status: string;
  overall: number | null;
  compliance: number | null;
  reliability: number | null;
  underReview: boolean;
  delta: number | null;
  updated: { reason: string; revision: number } | null;
  metrics: { code: string; numerator: number; denominator: number; value: number | null; applicable: boolean }[];
  nudges: { code: string }[];
  primaryAction: { code: string } | null;
  benchmark: { suppressed: boolean; value: number | null } | null;
}

const CONFIG_V1 = {
  ...DEFAULT_SCORE_CONFIG,
  minEvidence: { eligibleVisits: 3, qualityChecks: 10 },
  roleTargets: { mentor: 4 },
  defaultRoleTarget: 4,
};
const CONFIG_V2 = { ...CONFIG_V1, componentWeights: { compliance: 0.5, reliability: 0.5 } };

describe('mentor scoring', { skip: canRunIntegrationTests ? false : 'TEST_DATABASE_URL not set' }, () => {
  let context: TestContext;
  let admin: string;
  let manager: string;
  let sam: string;
  let priya: string;
  const ids: Record<string, string> = {};
  let period1 = '';
  let period2 = '';
  const flags: Record<string, string> = {};

  const visit = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    schoolId: 'school-a',
    startedAt: '2026-01-05T09:00:00Z',
    endedAt: '2026-01-05T09:40:00Z',
    spotApplicable: 2,
    spotCompleted: 2,
    inflationChecks: 5,
    consistencyChecks: 5,
    ...overrides,
  });
  const submit = (token: string, body: Record<string, unknown>) => api<{ id: string; created: boolean }>(context, 'POST', '/mentor/visits', { token, body });
  const decide = (token: string, flag: string, body: Record<string, unknown>) =>
    api<{ status: string }>(context, 'POST', `/admin/flags/${flag}/decision`, { token, body });

  before(async () => {
    context = await startTestServer();
    admin = await login(context, DEMO.admin);
    manager = await login(context, DEMO.manager);
    sam = await login(context, DEMO.frontend);
    priya = await login(context, DEMO.backend);
    for (const [name, token] of [['admin', admin], ['manager', manager], ['sam', sam], ['priya', priya]] as const) {
      ids[name] = (await api<{ actor: { id: string } }>(context, 'GET', '/whoami', { token })).body.actor.id;
    }
  });

  after(async () => context?.close());

  test('setup: only an admin can register mentors, publish configuration and create periods', async () => {
    const profile = { mentorRole: 'mentor', district: 'Bhopal', block: 'North' };
    assert.equal((await api(context, 'PUT', `/admin/mentors/${ids.sam}/profile`, { token: manager, body: profile })).status, 403);
    assert.equal((await api(context, 'PUT', `/admin/mentors/${ids.sam}/profile`, { token: sam, body: profile })).status, 403);
    for (const user of ['sam', 'priya', 'manager']) {
      const response = await api(context, 'PUT', `/admin/mentors/${ids[user]}/profile`, { token: admin, body: profile });
      assert.equal(response.status, 200);
    }

    const published = await api<{ version: number }>(context, 'POST', '/admin/config/publish', {
      token: admin,
      body: { config: CONFIG_V1, effectiveFrom: '2020-01-01', note: 'pilot' },
    });
    assert.equal(published.status, 201);
    assert.equal(published.body.version, 1);

    const broken = await api(context, 'POST', '/admin/config/publish', {
      token: admin,
      body: { config: { ...CONFIG_V1, componentWeights: { compliance: 0.5, reliability: 0.6 } }, effectiveFrom: '2020-01-01' },
    });
    assert.equal(broken.status, 422);

    const created = await api<{ id: string; end_date: string }>(context, 'POST', '/admin/periods', {
      token: admin,
      body: { startDate: '2026-01-05' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.end_date, '2026-01-18');
    period1 = created.body.id;

    const overlapping = await api(context, 'POST', '/admin/periods', { token: admin, body: { startDate: '2026-01-10' } });
    assert.equal(overlapping.status, 409);
  });

  test('T04/T13: visit submission is idempotent on the client id', async () => {
    const first = visit();
    ids.v1 = first.id;
    const created = await submit(sam, first);
    assert.equal(created.status, 201);
    const retried = await submit(sam, first);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.created, false);

    // Someone else cannot claim or overwrite the same id.
    assert.equal((await submit(priya, first)).status, 409);
    // A non-mentor is refused.
    const lin = await login(context, DEMO.qa);
    assert.equal((await submit(lin, visit())).status, 403);
  });

  test('sam records a mixed fortnight', async () => {
    const v2 = visit({ schoolId: 'school-b', startedAt: '2026-01-06T09:00:00Z', endedAt: '2026-01-06T10:30:00Z' }); // 90 min
    const v3 = visit({ schoolId: 'school-c', startedAt: '2026-01-07T09:00:00Z', endedAt: '2026-01-07T09:20:00Z', spotCompleted: 1 }); // too short
    const incomplete = visit({ schoolId: 'school-d', startedAt: '2026-01-07T12:00:00Z', endedAt: '2026-01-07T12:50:00Z', completed: false });
    const duplicate = visit({ startedAt: '2026-01-05T09:30:00Z', endedAt: '2026-01-05T10:10:00Z' }); // same school as v1, inside the window
    const v7 = visit({ schoolId: 'school-e', startedAt: '2026-01-08T09:00:00Z', endedAt: '2026-01-08T09:40:00Z', spotApplicable: 0, spotCompleted: 0 });
    ids.v2 = v2.id;
    ids.v3 = v3.id;
    ids.v7 = v7.id;
    for (const body of [v2, v3, incomplete, duplicate, v7]) assert.equal((await submit(sam, body)).status, 201);

    // Priya has a single visit: enough for a provisional score, not a final one.
    assert.equal((await submit(priya, visit({ schoolId: 'school-z' }))).status, 201);
    // The manager is a mentor too, outside her own reporting line.
    assert.equal((await submit(manager, visit({ schoolId: 'school-m' }))).status, 201);
  });

  test('flags: reviewers decide, mentors cannot, and every action is recorded', async () => {
    const create = (visitId: string, kind: string, ruleCode: string) =>
      api<{ id: string }>(context, 'POST', '/admin/flags', {
        token: manager,
        body: { visitId, kind, ruleCode, severity: 'medium', explanation: 'Two answers on this visit disagree.' },
      });
    flags.confirm = (await create(ids.v1!, 'contradiction', 'C-01')).body.id;
    flags.dismiss = (await create(ids.v2!, 'inflation', 'I-04')).body.id;
    flags.open = (await create(ids.v3!, 'contradiction', 'C-02')).body.id;
    assert.equal((await create(ids.v3!, 'contradiction', 'C-02')).status, 409);

    // A mentor cannot touch the review queue.
    assert.equal((await api(context, 'GET', '/admin/flags', { token: sam })).status, 403);
    assert.equal((await decide(sam, flags.confirm!, { decision: 'confirm', reasonCode: 'x' })).status, 403);

    // Confirm/dismiss need a reason.
    assert.equal((await decide(manager, flags.confirm!, { decision: 'confirm' })).status, 400);

    assert.equal((await decide(manager, flags.confirm!, { decision: 'start_review' })).body.status, 'in_review');
    const confirmed = await decide(manager, flags.confirm!, { decision: 'confirm', reasonCode: 'audit_agrees', note: 'NP visit disagreed' });
    assert.equal(confirmed.body.status, 'confirmed');
    assert.equal((await decide(manager, flags.dismiss!, { decision: 'dismiss', reasonCode: 'false_positive' })).body.status, 'dismissed');
    // Decisions are final.
    assert.equal((await decide(manager, flags.confirm!, { decision: 'dismiss', reasonCode: 'oops' })).status, 409);

    const queue = await api<{ items: { id: string; status: string }[] }>(context, 'GET', '/admin/flags?status=new', { token: manager });
    assert.deepEqual(queue.body.items.map((item) => item.id), [flags.open]);

    const audit = await api<{ items: { action: string }[] }>(context, 'GET', '/admin/audit-logs?action=mentor_flag', { token: admin });
    assert.ok(audit.body.items.some((entry) => entry.action === 'mentor_flag.confirm'));
  });

  test('a reviewer cannot review a flag on their own record', async () => {
    const own = await submit(manager, visit({ schoolId: 'school-m2', startedAt: '2026-01-09T09:00:00Z', endedAt: '2026-01-09T09:45:00Z' }));
    const flag = await api<{ id: string }>(context, 'POST', '/admin/flags', {
      token: admin,
      body: { visitId: own.body.id, kind: 'inflation', ruleCode: 'I-01', explanation: 'Unusual pattern.' },
    });
    assert.equal(flag.status, 201);
    // Maya is not in her own reporting line, so the flag is not even visible to her.
    assert.equal((await decide(manager, flag.body.id, { decision: 'dismiss', reasonCode: 'self' })).status, 404);
    assert.equal((await decide(admin, flag.body.id, { decision: 'dismiss', reasonCode: 'false_positive' })).status, 200);
  });

  test('closing is refused before the period ends, and by anyone but an admin', async () => {
    const early = await api(context, 'POST', `/admin/periods/${period1}/close`, { token: manager });
    assert.equal(early.status, 403);
  });

  test('T10/T01-T06: closing freezes the evidence and computes the documented score', async () => {
    const closed = await api<{ scored: number }>(context, 'POST', `/admin/periods/${period1}/close`, { token: admin });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.scored, 3);
    assert.equal((await api(context, 'POST', `/admin/periods/${period1}/close`, { token: admin })).status, 409);

    const scores = await api<{
      summary: { mentors: number; percentFinal: number; percentProvisional: number };
      items: { name: string; overall: number; compliance: number; reliability: number; status: string; flags: { flagged: number; confirmed: number }; visits: { valid: number; expected: number } }[];
    }>(context, 'GET', `/admin/scores?period_id=${period1}`, { token: admin });
    assert.equal(scores.status, 200);
    const samRow = scores.body.items.find((item) => item.name === 'Sam Rivera')!;
    // Coverage 100 (4/4), duration 3/4 = 75, spot 5/6 = 83.33  => compliance 91.67
    // Contradictions 1/20 => 95, inflation 20/20 => 100       => reliability 97.50
    assert.equal(samRow.compliance, 91.67);
    assert.equal(samRow.reliability, 97.5);
    assert.equal(samRow.overall, 95.17);
    assert.equal(samRow.status, 'final');
    assert.deepEqual(samRow.visits, { valid: 4, expected: 4 });
    assert.deepEqual(samRow.flags, { flagged: 1, confirmed: 1 });
    assert.equal(scores.body.items.find((item) => item.name === 'Priya Nair')!.status, 'provisional');
  });

  test('shadow mode: mentors see nothing until the period is published', async () => {
    assert.equal((await api(context, 'GET', '/mentor/report-card', { token: sam })).status, 404);
    assert.equal((await api(context, 'GET', `/mentor/report-card?period_id=${period1}`, { token: sam })).status, 404);

    assert.equal((await api(context, 'POST', `/admin/periods/${period1}/publish`, { token: manager })).status, 403);
    assert.equal((await api(context, 'POST', `/admin/periods/${period1}/publish`, { token: admin })).status, 200);
  });

  test('T12: a mentor sees only their own card, with numerator and denominator for every number', async () => {
    const card = await api<ReportCard>(context, 'GET', '/mentor/report-card', { token: sam });
    assert.equal(card.status, 200);
    assert.equal(card.body.overall, 95);
    assert.equal(card.body.compliance, 92);
    assert.equal(card.body.reliability, 98);
    assert.equal(card.body.status, 'final');
    assert.equal(card.body.underReview, true); // one flag still open, which costs nothing

    const byCode = Object.fromEntries(card.body.metrics.map((metric) => [metric.code, metric]));
    assert.deepEqual([byCode.visit_coverage!.numerator, byCode.visit_coverage!.denominator], [4, 4]);
    assert.deepEqual([byCode.duration_validity!.numerator, byCode.duration_validity!.denominator], [3, 4]);
    assert.deepEqual([byCode.spot_completion!.numerator, byCode.spot_completion!.denominator], [5, 6]);
    assert.deepEqual([byCode.contradiction_reliability!.numerator, byCode.contradiction_reliability!.denominator], [1, 20]);
    // Largest point loss: duration validity (2.0) ahead of the contradiction (1.5) and spot completion (1.3).
    assert.equal(card.body.primaryAction!.code, 'duration_low');
    assert.ok(!JSON.stringify(card.body).match(/rank|bottom|worst/i));

    // Priya's card is her own, and Sam cannot reach it by any parameter.
    const priyaCard = await api<ReportCard>(context, 'GET', '/mentor/report-card', { token: priya });
    assert.equal(priyaCard.body.status, 'provisional');
    const sneaky = await api<ReportCard>(context, 'GET', `/mentor/report-card?period_id=${period1}&mentor_id=${ids.priya}`, { token: sam });
    assert.equal(sneaky.body.overall, 95);
    // Mentors have no way into the admin views.
    assert.equal((await api(context, 'GET', `/admin/scores/${ids.priya}`, { token: sam })).status, 403);
    assert.equal((await api(context, 'GET', '/admin/scores', { token: sam })).status, 403);
  });

  test('evidence shows each visit and why it did or did not count, without internal rule ids', async () => {
    const evidence = await api<{
      visits: { counted: boolean; reasons: string[] }[];
      flags: { status: string; affectsScore: boolean; why: string; ruleCode?: string }[];
    }>(context, 'GET', `/mentor/report-card/${period1}/evidence`, { token: sam });
    assert.equal(evidence.status, 200);
    assert.equal(evidence.body.visits.filter((entry) => entry.counted).length, 4);
    const rejected = evidence.body.visits.filter((entry) => !entry.counted).flatMap((entry) => entry.reasons);
    assert.deepEqual(rejected.sort(), ['Duplicate of another visit', 'Visit was not completed']);
    assert.equal(evidence.body.flags.length, 3);
    assert.deepEqual(
      evidence.body.flags.map((flag) => [flag.status, flag.affectsScore]).sort(),
      [['confirmed', true], ['dismissed', false], ['new', false]],
    );
    for (const flag of evidence.body.flags) assert.equal(flag.ruleCode, undefined);

    const other = await api(context, 'GET', `/mentor/report-card/${randomUUID()}/evidence`, { token: sam });
    assert.equal(other.status, 404);
  });

  test('managers see their reporting line only; admins see everyone', async () => {
    const asManager = await api<{ items: { name: string }[] }>(context, 'GET', `/admin/scores?period_id=${period1}`, { token: manager });
    assert.deepEqual(asManager.body.items.map((item) => item.name).sort(), ['Priya Nair', 'Sam Rivera']);
    const asAdmin = await api<{ items: { name: string }[] }>(context, 'GET', `/admin/scores?period_id=${period1}`, { token: admin });
    assert.equal(asAdmin.body.items.length, 3);

    assert.equal((await api(context, 'GET', `/admin/scores/${ids.manager}?period_id=${period1}`, { token: manager })).status, 404);
    const drill = await api<{ drivers: unknown[]; reviews: { decision: string }[]; configVersion: number }>(
      context,
      'GET',
      `/admin/scores/${ids.sam}?period_id=${period1}`,
      { token: manager },
    );
    assert.equal(drill.status, 200);
    assert.equal(drill.body.drivers.length, 5);
    assert.equal(drill.body.configVersion, 1);
    assert.ok(drill.body.reviews.some((review) => review.decision === 'confirm'));
  });

  test('T08: a confirmation after close changes nothing until an audited recalculation', async () => {
    assert.equal((await decide(manager, flags.open!, { decision: 'confirm', reasonCode: 'audit_agrees' })).body.status, 'confirmed');

    const unchanged = await api<ReportCard>(context, 'GET', '/mentor/report-card', { token: sam });
    assert.equal(unchanged.body.reliability, 98);
    assert.equal(unchanged.body.updated, null);

    const refused = await api(context, 'POST', '/admin/recalculate', {
      token: manager,
      body: { periodId: period1, mentorId: ids.sam, reason: 'late confirmation' },
    });
    assert.equal(refused.status, 403);
    const shortReason = await api(context, 'POST', '/admin/recalculate', { token: admin, body: { periodId: period1, mentorId: ids.sam, reason: 'x' } });
    assert.equal(shortReason.status, 400);

    const recalculated = await api<{ version: number; before: { overall: number }; after: { overall: number } }>(
      context,
      'POST',
      '/admin/recalculate',
      { token: admin, body: { periodId: period1, mentorId: ids.sam, reason: 'Late confirmation of C-02' } },
    );
    assert.equal(recalculated.status, 200);
    assert.equal(recalculated.body.version, 2);
    assert.equal(recalculated.body.before.overall, 95.17);
    // Contradictions 2/20 => 90, reliability 95, overall 0.4*91.67 + 0.6*95 = 93.67
    assert.equal(recalculated.body.after.overall, 93.67);

    const updated = await api<ReportCard>(context, 'GET', '/mentor/report-card', { token: sam });
    assert.equal(updated.body.overall, 94);
    assert.equal(updated.body.updated!.reason, 'Late confirmation of C-02');
    assert.equal(updated.body.underReview, false);

    // Recalculating again must not count the same confirmation twice.
    const again = await api<{ after: { overall: number } }>(context, 'POST', '/admin/recalculate', {
      token: admin,
      body: { periodId: period1, mentorId: ids.sam, reason: 'Re-run to confirm stability' },
    });
    assert.equal(again.body.after.overall, 93.67);

    const drill = await api<{ events: { event_type: string }[] }>(context, 'GET', `/admin/scores/${ids.sam}?period_id=${period1}`, { token: admin });
    assert.deepEqual(drill.body.events.map((event) => event.event_type), ['calculated', 'published', 'recalculated', 'recalculated']);
  });

  test('T09/T11: a new configuration applies to new periods and never to closed ones', async () => {
    const tooEarly = await api(context, 'POST', '/admin/config/publish', {
      token: admin,
      body: { config: CONFIG_V2, effectiveFrom: '2026-01-10' },
    });
    assert.equal(tooEarly.status, 422);

    const v2 = await api<{ version: number }>(context, 'POST', '/admin/config/publish', {
      token: admin,
      body: { config: CONFIG_V2, effectiveFrom: '2026-01-19' },
    });
    assert.equal(v2.body.version, 2);

    const past = await api<ReportCard>(context, 'GET', `/mentor/report-card?period_id=${period1}`, { token: sam });
    assert.equal(past.body.overall, 94);

    const p2 = await api<{ id: string }>(context, 'POST', '/admin/periods', { token: admin, body: { startDate: '2026-01-19' } });
    period2 = p2.body.id;
  });

  test('preview scores frozen evidence under a candidate configuration without writing', async () => {
    const preview = await api<{ baselineConfigVersion: number; mentors: { mentorId: string; before: { overall: number }; after: { overall: number } }[] }>(
      context,
      'POST',
      '/admin/config/preview',
      { token: admin, body: { periodId: period1, config: CONFIG_V2 } },
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.body.baselineConfigVersion, 1);
    const samRow = preview.body.mentors.find((entry) => entry.mentorId === ids.sam)!;
    // Equal weights: 0.5*91.67 + 0.5*95 = 93.33 versus 93.67 under 40/60.
    assert.equal(samRow.before.overall, 93.67);
    assert.equal(samRow.after.overall, 93.33);
    assert.equal((await api(context, 'GET', '/mentor/report-card', { token: sam })).body !== null, true);
    assert.equal((await api(context, 'POST', '/admin/config/preview', { token: manager, body: { periodId: period1, config: CONFIG_V2 } })).status, 403);
  });

  test('published configurations are immutable in the database itself', async () => {
    const { query } = await import('../../src/db/pool.ts');
    await assert.rejects(query(`UPDATE mentor_score_configs SET config = '{}'::jsonb`), /immutable/);
    await assert.rejects(query(`DELETE FROM mentor_score_configs`), /immutable/);
  });

  test('carryover: a flag confirmed after close lands on the next period, once, on that period\'s configuration', async () => {
    // A new flag on an already-closed visit, confirmed after period 1 closed.
    const late = await api<{ id: string }>(context, 'POST', '/admin/flags', {
      token: manager,
      body: { visitId: ids.v7, kind: 'inflation', ruleCode: 'I-09', explanation: 'Positive answers do not match the audit sample.' },
    });
    await decide(manager, late.body.id, { decision: 'confirm', reasonCode: 'audit_agrees' });

    for (const [index, school] of ['f', 'g', 'h', 'i'].entries()) {
      const day = String(19 + index).padStart(2, '0');
      const response = await submit(
        sam,
        visit({ schoolId: `school-${school}`, startedAt: `2026-01-${day}T09:00:00Z`, endedAt: `2026-01-${day}T09:45:00Z`, spotApplicable: 0, spotCompleted: 0 }),
      );
      assert.equal(response.status, 201);
    }

    const closed = await api(context, 'POST', `/admin/periods/${period2}/close`, { token: admin });
    assert.equal(closed.status, 200);
    await api(context, 'POST', `/admin/periods/${period2}/publish`, { token: admin });

    const card = await api<ReportCard>(context, 'GET', `/mentor/report-card?period_id=${period2}`, { token: sam });
    const byCode = Object.fromEntries(card.body.metrics.map((metric) => [metric.code, metric]));
    // Spot assessment never applied, so compliance rescales to coverage + duration = 100.
    assert.equal(byCode.spot_completion!.applicable, false);
    assert.equal(card.body.compliance, 100);
    // The carried confirmation: 1 of 20 inflation checks => 95; contradictions clean => 100.
    assert.deepEqual([byCode.inflation_reliability!.numerator, byCode.inflation_reliability!.denominator], [1, 20]);
    assert.equal(byCode.contradiction_reliability!.value, 100);
    assert.equal(card.body.reliability, 98); // 97.5
    // Version 2 weights (50/50): 0.5*100 + 0.5*97.5 = 98.75
    assert.equal(card.body.overall, 99);
    // Delta compares whole displayed points against period 1 (94).
    assert.equal(card.body.delta, 5);
    assert.ok(card.body.nudges.some((nudge) => nudge.code === 'most_improved'));

    const history = await api<{ items: { overall: number; delta: number | null; revision: number }[] }>(context, 'GET', '/mentor/history', { token: sam });
    assert.deepEqual(history.body.items.map((item) => item.overall), [99, 94]);
    assert.equal(history.body.items[1]!.revision, 3);

    // Period 1 was frozen on config v1 and still is.
    const drill = await api<{ configVersion: number }>(context, 'GET', `/admin/scores/${ids.sam}?period_id=${period1}`, { token: admin });
    assert.equal(drill.body.configVersion, 1);
    const drill2 = await api<{ configVersion: number }>(context, 'GET', `/admin/scores/${ids.sam}?period_id=${period2}`, { token: admin });
    assert.equal(drill2.body.configVersion, 2);
  });

  test('benchmarks are suppressed for a cohort below the minimum', async () => {
    const card = await api<ReportCard>(context, 'GET', `/mentor/report-card?period_id=${period1}`, { token: sam });
    assert.equal(card.body.benchmark!.suppressed, true);
    assert.equal(card.body.benchmark!.value, null);
  });
});
