import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeCapacity, recommendAssignees, rollupTeamCapacity, utilizationBand } from '../src/capacity.ts';

test('a half-booked week is healthy with bandwidth left', () => {
  const snapshot = computeCapacity({ weeklyCapacityHours: 40, leaveHours: 0, plannedHours: 28 });
  assert.equal(snapshot.effectiveCapacityHours, 40);
  assert.equal(snapshot.availableHours, 12);
  assert.equal(snapshot.overAllocationHours, 0);
  assert.equal(snapshot.utilization, 0.7);
  assert.equal(snapshot.band, 'healthy');
});

test('leave reduces effective capacity and pushes utilization up', () => {
  // 20h of work is a relaxed 50% of a full week, but 83% of a week with two
  // days of leave taken out of it.
  const snapshot = computeCapacity({ weeklyCapacityHours: 40, leaveHours: 16, plannedHours: 20 });
  assert.equal(snapshot.effectiveCapacityHours, 24);
  assert.equal(snapshot.availableHours, 4);
  assert.equal(snapshot.utilization, 0.83);
  assert.equal(snapshot.band, 'healthy');

  // One more planned task tips the same week into amber.
  const amber = computeCapacity({ weeklyCapacityHours: 40, leaveHours: 16, plannedHours: 21 });
  assert.equal(amber.utilization, 0.88);
  assert.equal(amber.band, 'near_capacity');
});

test('planned work beyond capacity reports over-allocation, not negative availability', () => {
  const snapshot = computeCapacity({ weeklyCapacityHours: 40, leaveHours: 0, plannedHours: 52 });
  assert.equal(snapshot.availableHours, 0);
  assert.equal(snapshot.overAllocationHours, 12);
  assert.equal(snapshot.band, 'overloaded');
});

test('full week of leave with planned work is overloaded rather than NaN', () => {
  const snapshot = computeCapacity({ weeklyCapacityHours: 40, leaveHours: 40, plannedHours: 8 });
  assert.equal(snapshot.effectiveCapacityHours, 0);
  assert.equal(snapshot.utilization, Infinity);
  assert.equal(snapshot.band, 'overloaded');
});

test('leave is clamped to the contracted week', () => {
  const snapshot = computeCapacity({ weeklyCapacityHours: 40, leaveHours: 60, plannedHours: 0 });
  assert.equal(snapshot.leaveHours, 40);
  assert.equal(snapshot.utilization, 0);
  assert.equal(snapshot.band, 'underutilized');
});

test('band thresholds sit where the colour indicators expect them', () => {
  assert.equal(utilizationBand(0.4), 'underutilized');
  assert.equal(utilizationBand(0.6), 'healthy');
  assert.equal(utilizationBand(0.85), 'near_capacity');
  assert.equal(utilizationBand(1), 'near_capacity');
  assert.equal(utilizationBand(1.01), 'overloaded');
});

test('team rollup sums capacity and counts the outliers', () => {
  const rollup = rollupTeamCapacity([
    computeCapacity({ weeklyCapacityHours: 40, leaveHours: 0, plannedHours: 44 }),
    computeCapacity({ weeklyCapacityHours: 40, leaveHours: 0, plannedHours: 10 }),
    computeCapacity({ weeklyCapacityHours: 20, leaveHours: 0, plannedHours: 15 }),
  ]);
  assert.equal(rollup.totalCapacityHours, 100);
  assert.equal(rollup.totalPlannedHours, 69);
  assert.equal(rollup.overloadedCount, 1);
  assert.equal(rollup.underutilizedCount, 1);
  assert.equal(rollup.memberCount, 3);
});

test('recommendation prefers the skilled candidate who still has room', () => {
  const [best, second] = recommendAssignees(
    [
      {
        userId: 'u-busy',
        displayName: 'Busy Bella',
        skills: ['react', 'graphql'],
        capacity: computeCapacity({ weeklyCapacityHours: 40, leaveHours: 0, plannedHours: 38 }),
        openTaskCount: 9,
      },
      {
        userId: 'u-free',
        displayName: 'Free Fred',
        skills: ['react', 'graphql'],
        capacity: computeCapacity({ weeklyCapacityHours: 40, leaveHours: 0, plannedHours: 8 }),
        openTaskCount: 2,
      },
    ],
    { requiredSkills: ['React', 'GraphQL'], estimatedHours: 8 },
  );
  assert.equal(best?.userId, 'u-free');
  assert.equal(best?.skillMatch, 1);
  assert.equal(second?.userId, 'u-busy');
  assert.ok((best?.score ?? 0) > (second?.score ?? 1));
});

test('missing skills are reported so the manager can override knowingly', () => {
  const [top] = recommendAssignees(
    [
      {
        userId: 'u-1',
        displayName: 'Ada',
        skills: ['react'],
        capacity: computeCapacity({ weeklyCapacityHours: 40, leaveHours: 0, plannedHours: 0 }),
        openTaskCount: 0,
      },
    ],
    { requiredSkills: ['react', 'kubernetes'], estimatedHours: 4 },
  );
  assert.deepEqual(top?.matchedSkills, ['react']);
  assert.deepEqual(top?.missingSkills, ['kubernetes']);
  assert.equal(top?.skillMatch, 0.5);
});

test('ties break deterministically on open task count then name', () => {
  const capacity = computeCapacity({ weeklyCapacityHours: 40, leaveHours: 0, plannedHours: 10 });
  const ranked = recommendAssignees([
    { userId: 'b', displayName: 'Bob', skills: [], capacity, openTaskCount: 3 },
    { userId: 'a', displayName: 'Alice', skills: [], capacity, openTaskCount: 3 },
    { userId: 'c', displayName: 'Cara', skills: [], capacity, openTaskCount: 1 },
  ]);
  assert.deepEqual(
    ranked.map((r) => r.userId),
    ['c', 'a', 'b'],
  );
});
