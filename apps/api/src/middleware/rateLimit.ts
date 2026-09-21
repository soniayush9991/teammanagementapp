import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/errors.js';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window limiter held in process memory. It is deliberately simple:
 * single-instance protection against credential stuffing and runaway
 * clients. Behind more than one API instance, swap the store for Redis
 * (see docs/14-security-and-permissions.md).
 */
export function rateLimit(options: { windowMs: number; max: number; keyBy?: (req: Request) => string }) {
  const buckets = new Map<string, Bucket>();
  const keyBy = options.keyBy ?? ((req: Request) => req.actor?.id ?? req.ip ?? 'anonymous');

  // Stale buckets are swept lazily so the map cannot grow without bound.
  function sweep(now: number): void {
    if (buckets.size < 1_000) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    sweep(now);

    const key = keyBy(req);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      res.setHeader('x-ratelimit-remaining', options.max - 1);
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > options.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('retry-after', retryAfter);
      next(ApiError.tooManyRequests(`Rate limit exceeded, retry in ${retryAfter}s`));
      return;
    }

    res.setHeader('x-ratelimit-remaining', Math.max(0, options.max - bucket.count));
    next();
  };
}

/** Login and refresh are the endpoints worth limiting hardest. */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyBy: (req) => `${req.ip}:${String((req.body as { email?: string } | undefined)?.email ?? '')}`,
});

export const writeRateLimit = rateLimit({ windowMs: 60 * 1000, max: 120 });
export const searchRateLimit = rateLimit({ windowMs: 60 * 1000, max: 60 });
