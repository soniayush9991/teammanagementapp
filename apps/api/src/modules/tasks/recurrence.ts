import type { RecurrenceFrequency } from '@teamspace/shared';

/**
 * Next occurrence for a recurring task. Monthly recurrence clamps to the end
 * of a shorter month (31 Jan + 1 month = 28/29 Feb) rather than rolling over
 * into March, which is what people expect from a "monthly on the 31st" rule.
 */
export function nextOccurrence(
  from: Date,
  frequency: RecurrenceFrequency,
  interval: number,
): Date {
  const step = Math.max(1, interval);
  const next = new Date(from.getTime());

  switch (frequency) {
    case 'daily':
      next.setUTCDate(next.getUTCDate() + step);
      return next;
    case 'weekly':
      next.setUTCDate(next.getUTCDate() + 7 * step);
      return next;
    case 'biweekly':
      next.setUTCDate(next.getUTCDate() + 14 * step);
      return next;
    case 'monthly': {
      const dayOfMonth = next.getUTCDate();
      const target = new Date(
        Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + step, 1, next.getUTCHours(), next.getUTCMinutes()),
      );
      const daysInTargetMonth = new Date(
        Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
      ).getUTCDate();
      target.setUTCDate(Math.min(dayOfMonth, daysInTargetMonth));
      return target;
    }
    default: {
      const exhaustive: never = frequency;
      throw new Error(`Unhandled recurrence frequency: ${String(exhaustive)}`);
    }
  }
}

/** True when the rule has run past its end date and should stop. */
export function isRecurrenceExhausted(next: Date, until: Date | null): boolean {
  if (!until) return false;
  return next.getTime() > until.getTime();
}
