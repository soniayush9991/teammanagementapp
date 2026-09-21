import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { isProduction } from '../env.js';

interface PostgresError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
}

/** Maps database-level failures onto the right HTTP status. */
function fromPostgres(error: PostgresError): ApiError | null {
  switch (error.code) {
    case '23505': // unique_violation
      return ApiError.conflict('That record already exists', { constraint: error.constraint });
    case '23503': // foreign_key_violation
      return ApiError.badRequest('Referenced record does not exist', { constraint: error.constraint });
    case '23514': // check_violation
      return ApiError.unprocessable('Value violates a data integrity rule', { constraint: error.constraint });
    case '23502': // not_null_violation
      return ApiError.badRequest('A required field was missing');
    case '40001': // serialization_failure
      return new ApiError(409, 'serialization_failure', 'Concurrent update, please retry');
    case '57014': // query_canceled (statement_timeout)
      return new ApiError(503, 'statement_timeout', 'The query took too long, please narrow your request');
    default:
      return null;
  }
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new ApiError(404, 'route_not_found', `No route for ${req.method} ${req.path}`));
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  let apiError: ApiError;

  if (error instanceof ApiError) {
    apiError = error;
  } else if (error instanceof ZodError) {
    apiError = ApiError.badRequest('Validation failed', error.issues);
  } else {
    const postgresError = fromPostgres(error as PostgresError);
    apiError = postgresError ?? ApiError.internal();
  }

  if (apiError.status >= 500) {
    logger.error({ err: error, path: req.path, method: req.method, actor: req.actor?.id }, 'request failed');
  } else {
    logger.debug({ code: apiError.code, path: req.path, actor: req.actor?.id }, 'request rejected');
  }

  res.status(apiError.status).json({
    error: {
      code: apiError.code,
      // Internal messages are never echoed to clients in production.
      message: apiError.status >= 500 && isProduction() ? 'Unexpected server error' : apiError.message,
      details: apiError.status >= 500 ? undefined : apiError.details,
      requestId: res.getHeader('x-request-id') ?? undefined,
    },
  });
}
