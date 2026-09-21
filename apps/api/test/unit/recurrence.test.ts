import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRecurrenceExhausted, nextOccurrence } from '../../src/modules/tasks/recurrence.ts';

const at = (iso: string): Date => new Date(`${iso}T09:00:00Z`);
const day = (date: Date): string => date.toISOString().slice(0, 10);

test('daily and weekly recurrence step by the interval', () => {
  assert.equal(day(nextOccurrence(at('2026-09-21'), 'daily', 1)), '2026-09-22');
  assert.equal(day(nextOccurrence(at('2026-09-21'), 'daily', 3)), '2026-09-24');
  assert.equal(day(nextOccurrence(at('2026-09-21'), 'weekly', 1)), '2026-09-28');
  assert.equal(day(nextOccurrence(at('2026-09-21'), 'biweekly', 1)), '2026-10-05');
});

test('monthly recurrence keeps the day of month', () => {
  assert.equal(day(nextOccurrence(at('2026-09-15'), 'monthly', 1)), '2026-10-15');
  assert.equal(day(nextOccurrence(at('2026-09-15'), 'monthly', 3)), '2026-12-15');
});

test('monthly from the 31st clamps to a shorter month instead of skipping it', () => {
  // Naive date arithmetic would roll 31 Jan into 3 March.
  assert.equal(day(nextOccurrence(at('2026-01-31'), 'monthly', 1)), '2026-02-28');
  assert.equal(day(nextOccurrence(at('2028-01-31'), 'monthly', 1)), '2028-02-29');
  assert.equal(day(nextOccurrence(at('2026-05-31'), 'monthly', 1)), '2026-06-30');
});

test('recurrence crossing a year boundary stays correct', () => {
  assert.equal(day(nextOccurrence(at('2026-12-20'), 'weekly', 2)), '2027-01-03');
  assert.equal(day(nextOccurrence(at('2026-11-30'), 'monthly', 2)), '2027-01-30');
});

test('a rule stops once it passes its end date', () => {
  assert.equal(isRecurrenceExhausted(at('2026-10-01'), at('2026-09-30')), true);
  assert.equal(isRecurrenceExhausted(at('2026-09-30'), at('2026-09-30')), false);
  assert.equal(isRecurrenceExhausted(at('2030-01-01'), null), false);
});
