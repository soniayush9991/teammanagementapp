import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodSchema } from 'zod';
import { ApiError } from './errors.js';

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function asyncHandler<T>(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<T>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export function parseBody<S extends ZodSchema>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw ApiError.badRequest('Request body failed validation', formatIssues(result.error));
  }
  return result.data;
}

export function parseQuery<S extends ZodSchema>(schema: S, queryParams: unknown): z.infer<S> {
  const result = schema.safeParse(queryParams);
  if (!result.success) {
    throw ApiError.badRequest('Query parameters failed validation', formatIssues(result.error));
  }
  return result.data;
}

function formatIssues(error: z.ZodError): { field: string; message: string }[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

export const uuid = z.string().uuid('must be a UUID');

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

/**
 * Cursors are opaque to clients but are just base64 of the sort key, which
 * keeps keyset pagination stable while rows are inserted during paging.
 */
export function encodeCursor(value: { createdAt: string | Date; id: string }): string {
  const createdAt = value.createdAt instanceof Date ? value.createdAt.toISOString() : value.createdAt;
  return Buffer.from(`${createdAt}|${value.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('|');
  if (separator === -1) throw ApiError.badRequest('Malformed pagination cursor');
  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) {
    throw ApiError.badRequest('Malformed pagination cursor');
  }
  return { createdAt, id };
}
