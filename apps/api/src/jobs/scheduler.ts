import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { runRetention } from './retention.js';
import { runReminders } from './reminders.js';

/**
 * A minimal in-process scheduler. It is deliberately not a distributed job
 * queue: with more than one API instance, set `RUN_JOBS=false` on the web
 * instances and run `jobs/runner.ts` as a single worker (or hand the
 * schedules to Kubernetes CronJobs). Overlap is prevented per job so a slow
 * run cannot stack up behind itself.
 */
export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private running = new Set<string>();

  start(): void {
    this.every('retention', env().RETENTION_JOB_CRON_MINUTES, async () => {
      await runRetention();
    });
    this.every('reminders', env().REMINDER_JOB_CRON_MINUTES, async () => {
      await runReminders();
    });
    logger.info(
      {
        retentionEveryMinutes: env().RETENTION_JOB_CRON_MINUTES,
        remindersEveryMinutes: env().REMINDER_JOB_CRON_MINUTES,
      },
      'background scheduler started',
    );
  }

  private every(name: string, minutes: number, task: () => Promise<void>): void {
    const run = async (): Promise<void> => {
      if (this.running.has(name)) {
        logger.warn({ job: name }, 'skipping job run, previous run still in flight');
        return;
      }
      this.running.add(name);
      try {
        await task();
      } catch (error) {
        // A failing job must never take the API process down with it.
        logger.error({ err: error, job: name }, 'scheduled job failed');
      } finally {
        this.running.delete(name);
      }
    };

    const timer = setInterval(() => void run(), minutes * 60_000);
    timer.unref();
    this.timers.push(timer);
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
