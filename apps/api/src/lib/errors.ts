/**
 * All handler failures are thrown as ApiError so the error middleware can
 * turn them into a consistent JSON body without leaking internals.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, 'bad_request', message, details);
  }

  static unauthorized(message = 'Authentication required'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }

  static forbidden(message = 'You do not have access to this resource'): ApiError {
    return new ApiError(403, 'forbidden', message);
  }

  static notFound(resource = 'Resource'): ApiError {
    return new ApiError(404, 'not_found', `${resource} not found`);
  }

  static conflict(message: string, details?: unknown): ApiError {
    return new ApiError(409, 'conflict', message, details);
  }

  static unprocessable(message: string, details?: unknown): ApiError {
    return new ApiError(422, 'unprocessable_entity', message, details);
  }

  static tooManyRequests(message = 'Too many requests'): ApiError {
    return new ApiError(429, 'rate_limited', message);
  }

  static internal(message = 'Unexpected server error'): ApiError {
    return new ApiError(500, 'internal_error', message);
  }
}
