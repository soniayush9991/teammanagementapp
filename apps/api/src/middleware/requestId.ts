import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Correlates a client report, a log line and an audit entry. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  // Only accept a client-supplied id when it looks like one, so it cannot be
  // used to inject content into log lines.
  const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', id);
  next();
}
