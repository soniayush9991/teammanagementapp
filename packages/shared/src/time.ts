/**
 * ISO week helpers. Capacity is planned per ISO week (Monday start) so that
 * the API, the reports and the planner UI all bucket work identically.
 */

const MS_PER_DAY = 86_400_000;

export function startOfIsoWeek(date: Date): Date {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() === 0 ? 7 : utc.getUTCDay();
  utc.setUTCDate(utc.getUTCDate() - (day - 1));
  return utc;
}

export function endOfIsoWeek(date: Date): Date {
  const start = startOfIsoWeek(date);
  return new Date(start.getTime() + 6 * MS_PER_DAY);
}

export function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** e.g. 2026-W39 — the storage key for a capacity row. */
export function isoWeekKey(date: Date): string {
  const target = startOfIsoWeek(date);
  const thursday = new Date(target.getTime() + 3 * MS_PER_DAY);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstWeekStart = startOfIsoWeek(firstThursday);
  const week = Math.round((target.getTime() - firstWeekStart.getTime()) / (7 * MS_PER_DAY)) + 1;
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function parseIsoWeekKey(key: string): { start: Date; end: Date } {
  const match = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!match) throw new Error(`Invalid ISO week key: ${key}`);
  const year = Number(match[1]);
  const week = Number(match[2]);
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstWeekStart = startOfIsoWeek(firstThursday);
  const start = new Date(firstWeekStart.getTime() + (week - 1) * 7 * MS_PER_DAY);
  return { start, end: new Date(start.getTime() + 6 * MS_PER_DAY) };
}

/**
 * Working days (Mon-Fri) that overlap a leave range inside one ISO week.
 * Used to convert a leave request into hours removed from capacity.
 */
export function workingDaysInWeek(weekStart: Date, rangeStart: Date, rangeEnd: Date): number {
  let count = 0;
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(weekStart.getTime() + i * MS_PER_DAY);
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (day >= startOfDay(rangeStart) && day <= startOfDay(rangeEnd)) count += 1;
  }
  return count;
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}
