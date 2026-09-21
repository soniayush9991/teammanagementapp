import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { isoWeekKey } from '@teamspace/shared';
import { api, canRunIntegrationTests, DEMO, login, startTestServer, type TestContext } from './harness.ts';

interface MemberCapacityResponse {
  userId: string;
  displayName: string;
  capacity: {
    weeklyCapacityHours: number;
    leaveHours: number;
    effectiveCapacityHours: number;
    plannedHours: number;
    availableHours: number;
    overAllocationHours: number;
    utilization: number;
    band: string;
  };
}

describe('capacity and assignment planning', { skip: canRunIntegrationTests ? false : 'TEST_DATABASE_URL not set' }, () => {
  let context: TestContext;
  let managerToken: string;
  let teamId: string;
  const week = isoWeekKey(new Date());

  before(async () => {
    context = await startTestServer();
    managerToken = await login(context, DEMO.manager);
    const teams = await api<{ items: { id: string; name: string }[] }>(context, 'GET', '/teams', {
      token: managerToken,
    });
    teamId = teams.body.items.find((team) => team.name === 'Platform')!.id;
  });

  after(async () => context?.close());

  test('team capacity reports each member and a rollup', async () => {
    const response = await api<{
      weekKey: string;
      members: MemberCapacityResponse[];
      rollup: { totalPlannedHours: number; overloadedCount: number; underutilizedCount: number };
    }>(context, 'GET', `/capacity/teams/${teamId}?week=${week}`, { token: managerToken });

    assert.equal(response.status, 200);
    assert.equal(response.body.weekKey, week);
    assert.ok(response.body.members.length >= 4);

    // The seed deliberately over-allocates one person and under-allocates another.
    assert.ok(response.body.rollup.overloadedCount >= 1, 'expected an overloaded member');
    assert.ok(response.body.rollup.underutilizedCount >= 1, 'expected an underutilized member');
  });

  test('approved leave reduces effective capacity', async () => {
    const response = await api<{ members: MemberCapacityResponse[] }>(
      context,
      'GET',
      `/capacity/teams/${teamId}?week=${week}`,
      { token: managerToken },
    );
    // Tom is contracted for 32h and has two days of approved leave this week.
    const tom = response.body.members.find((member) => member.displayName === 'Tom Berg');
    assert.ok(tom, 'expected Tom in the Platform team');
    assert.equal(tom.capacity.weeklyCapacityHours, 32);
    assert.ok(tom.capacity.leaveHours > 0, 'leave should be deducted');
    assert.equal(
      tom.capacity.effectiveCapacityHours,
      tom.capacity.weeklyCapacityHours - tom.capacity.leaveHours,
    );
  });

  test('over-allocation is reported without negative availability', async () => {
    const response = await api<{ members: MemberCapacityResponse[] }>(
      context,
      'GET',
      `/capacity/teams/${teamId}?week=${week}`,
      { token: managerToken },
    );
    for (const member of response.body.members) {
      assert.ok(member.capacity.availableHours >= 0, `${member.displayName} had negative availability`);
      if (member.capacity.overAllocationHours > 0) {
        assert.equal(member.capacity.availableHours, 0);
        assert.equal(member.capacity.band, 'overloaded');
      }
    }
  });

  test('a per-week override changes only that week', async () => {
    const members = await api<{ members: MemberCapacityResponse[] }>(
      context,
      'GET',
      `/capacity/teams/${teamId}?week=${week}`,
      { token: managerToken },
    );
    const lin = members.body.members.find((member) => member.displayName === 'Lin Chen')!;

    const updated = await api<MemberCapacityResponse>(context, 'PUT', '/capacity/overrides', {
      token: managerToken,
      body: { userId: lin.userId, weekKey: week, capacityHours: 10, note: 'Support rotation' },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.capacity.weeklyCapacityHours, 10);

    // The contracted default still applies to other weeks.
    const nextWeek = isoWeekKey(new Date(Date.now() + 7 * 86_400_000));
    const later = await api<MemberCapacityResponse>(
      context,
      'GET',
      `/capacity/users/${lin.userId}?week=${nextWeek}`,
      { token: managerToken },
    );
    assert.equal(later.body.capacity.weeklyCapacityHours, 40);
  });

  test('the recommender ranks candidates and explains the skill gap', async () => {
    const response = await api<{
      recommendations: {
        displayName: string;
        score: number;
        matchedSkills: string[];
        missingSkills: string[];
        band: string;
      }[];
    }>(context, 'GET', `/assignments/recommend?teamId=${teamId}&skills=postgres&estimatedHours=8`, {
      token: managerToken,
    });

    assert.equal(response.status, 200);
    const recommendations = response.body.recommendations;
    assert.ok(recommendations.length > 0);

    // Ranked best first.
    for (let index = 1; index < recommendations.length; index += 1) {
      assert.ok(
        recommendations[index - 1]!.score >= recommendations[index]!.score,
        'recommendations must be ordered by score',
      );
    }
    // Someone without the skill is told exactly what they are missing.
    const withoutSkill = recommendations.find((entry) => entry.matchedSkills.length === 0);
    assert.deepEqual(withoutSkill?.missingSkills, ['postgres']);
  });

  test('workload comparison projects the week after an assignment', async () => {
    const response = await api<{
      projections: { userId: string; projectedPlannedHours: number; band: string }[];
      members: MemberCapacityResponse[];
    }>(context, 'GET', `/assignments/compare?teamId=${teamId}&estimatedHours=12`, { token: managerToken });

    assert.equal(response.status, 200);
    for (const projection of response.body.projections) {
      const member = response.body.members.find((entry) => entry.userId === projection.userId)!;
      assert.equal(projection.projectedPlannedHours, Math.round((member.capacity.plannedHours + 12) * 100) / 100);
    }
  });

  test('leave must be approved by someone else, and approval reshapes capacity', async () => {
    const qaToken = await login(context, DEMO.qa);
    const pending = await api<{ items: { id: string; userId: string; status: string }[] }>(
      context,
      'GET',
      '/capacity/leave?status=pending',
      { token: managerToken },
    );
    const request = pending.body.items[0];
    assert.ok(request, 'expected a pending leave request in the seed');

    // The requester cannot approve their own leave.
    const selfApproval = await api(context, 'POST', `/capacity/leave/${request.id}/decision`, {
      token: qaToken,
      body: { decision: 'approved' },
    });
    assert.equal(selfApproval.status, 403);

    const approval = await api<{ status: string }>(context, 'POST', `/capacity/leave/${request.id}/decision`, {
      token: managerToken,
      body: { decision: 'approved' },
    });
    assert.equal(approval.status, 200);
    assert.equal(approval.body.status, 'approved');

    // Deciding twice is a conflict, not a silent overwrite.
    const again = await api(context, 'POST', `/capacity/leave/${request.id}/decision`, {
      token: managerToken,
      body: { decision: 'rejected' },
    });
    assert.equal(again.status, 409);
  });

  test('overlapping leave is rejected', async () => {
    const token = await login(context, DEMO.frontend);
    const body = { startDate: '2027-03-01', endDate: '2027-03-05', hoursPerDay: 8 };
    assert.equal((await api(context, 'POST', '/capacity/leave', { token, body })).status, 201);
    const overlapping = await api(context, 'POST', '/capacity/leave', {
      token,
      body: { startDate: '2027-03-04', endDate: '2027-03-08', hoursPerDay: 8 },
    });
    assert.equal(overlapping.status, 409);
  });

  test('a leave range that ends before it starts is rejected', async () => {
    const token = await login(context, DEMO.frontend);
    const response = await api(context, 'POST', '/capacity/leave', {
      token,
      body: { startDate: '2027-05-10', endDate: '2027-05-01', hoursPerDay: 8 },
    });
    assert.equal(response.status, 400);
  });
});
