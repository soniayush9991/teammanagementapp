import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endOfIsoWeek, isoWeekKey, parseIsoWeekKey, startOfIsoWeek, toDateOnly, workingDaysInWeek } from '../src/time.ts';

test('ISO weeks start on Monday and end on Sunday', () => {
  // 2026-09-21 is a Monday.
  const wednesday = new Date('2026-09-23T14:00:00Z');
  assert.equal(toDateOnly(startOfIsoWeek(wednesday)), '2026-09-21');
  assert.equal(toDateOnly(endOfIsoWeek(wednesday)), '2026-09-27');
});

test('a Sunday belongs to the week that started six days earlier', () => {
  const sunday = new Date('2026-09-27T23:59:00Z');
  assert.equal(toDateOnly(startOfIsoWeek(sunday)), '2026-09-21');
});

test('week keys round-trip through parsing', () => {
  const key = isoWeekKey(new Date('2026-09-23T00:00:00Z'));
  assert.match(key, /^2026-W\d{2}$/);
  const { start, end } = parseIsoWeekKey(key);
  assert.equal(toDateOnly(start), '2026-09-21');
  assert.equal(toDateOnly(end), '2026-09-27');
});

test('leave spanning a week counts only weekdays', () => {
  const weekStart = startOfIsoWeek(new Date('2026-09-23T00:00:00Z'));
  assert.equal(workingDaysInWeek(weekStart, new Date('2026-09-21'), new Date('2026-09-27')), 5);
  assert.equal(workingDaysInWeek(weekStart, new Date('2026-09-23'), new Date('2026-09-24')), 2);
  assert.equal(workingDaysInWeek(weekStart, new Date('2026-09-26'), new Date('2026-09-27')), 0);
});

test('leave outside the week contributes nothing', () => {
  const weekStart = startOfIsoWeek(new Date('2026-09-23T00:00:00Z'));
  assert.equal(workingDaysInWeek(weekStart, new Date('2026-10-05'), new Date('2026-10-09')), 0);
});
