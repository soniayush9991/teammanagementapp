import type { NextFunction, Request, Response } from 'express';
import type { Permission, Role } from '@teamspace/shared';
import { roleHasPermission } from '@teamspace/shared';
import { queryOne } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { asyncHandler } from '../lib/http.js';
import { verifyAccessToken } from '../lib/tokens.js';

export interface AuthenticatedActor {
  id: string;
  orgId: string;
  role: Role;
  sessionId: string;
  displayName: string;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: AuthenticatedActor;
    }
  }
}

/**
 * Verifies the bearer token and confirms the user is still active. The extra
 * round trip matters: deactivating an account must take effect immediately,
 * not when the access token happens to expire.
 */
export const authenticate = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Missing bearer token');
  }
  const claims = verifyAccessToken(header.slice('Bearer '.length).trim());

  const user = await queryOne<{ id: string; org_id: string; role: Role; display_name: string; email: string }>(
    `SELECT id, org_id, role, display_name, email FROM users WHERE id = $1 AND is_active`,
    [claims.sub],
  );
  if (!user) throw ApiError.unauthorized('Account is inactive or no longer exists');

  // A role change mid-session must not be usable until the token is refreshed
  // with the new claims; refusing here keeps the token and the row in sync.
  if (user.role !== claims.role || user.org_id !== claims.orgId) {
    throw new ApiError(401, 'token_stale', 'Session is out of date, refresh the token');
  }

  req.actor = {
    id: user.id,
    orgId: user.org_id,
    role: user.role,
    sessionId: claims.sid,
    displayName: user.display_name,
    email: user.email,
  };
  next();
});

export function actorOf(req: Request): AuthenticatedActor {
  if (!req.actor) throw ApiError.unauthorized();
  return req.actor;
}

/** Route-level guard for the coarse, role-based half of authorization. */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const actor = actorOf(req);
    const missing = permissions.filter((permission) => !roleHasPermission(actor.role, permission));
    if (missing.length > 0) {
      next(ApiError.forbidden(`Your role (${actor.role}) is missing: ${missing.join(', ')}`));
      return;
    }
    next();
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const actor = actorOf(req);
    if (!roles.includes(actor.role)) {
      next(ApiError.forbidden(`This endpoint requires one of: ${roles.join(', ')}`));
      return;
    }
    next();
  };
}
