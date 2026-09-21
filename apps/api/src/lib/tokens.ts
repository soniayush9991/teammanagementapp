import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Role } from '@teamspace/shared';
import { env } from '../env.js';
import { ApiError } from './errors.js';

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  orgId: string;
  role: Role;
  /** Session id, so a refresh-token revocation can invalidate live sockets. */
  sid: string;
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env().JWT_ACCESS_SECRET, {
    expiresIn: env().ACCESS_TOKEN_TTL,
    issuer: 'teamspace',
    audience: 'teamspace-api',
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const payload = jwt.verify(token, env().JWT_ACCESS_SECRET, {
      issuer: 'teamspace',
      audience: 'teamspace-api',
    });
    if (typeof payload === 'string') throw new Error('unexpected token payload');
    const { sub, orgId, role, sid } = payload as jwt.JwtPayload & Partial<AccessTokenClaims>;
    if (!sub || !orgId || !role || !sid) throw new Error('incomplete token payload');
    return { sub, orgId, role, sid };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new ApiError(401, 'token_expired', 'Access token expired');
    }
    throw ApiError.unauthorized('Invalid access token');
  }
}

/**
 * Refresh tokens are opaque random strings, not JWTs: they must be
 * revocable, and only their SHA-256 hash is stored so a database leak does
 * not hand over live sessions.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function refreshTokenExpiry(now = new Date()): Date {
  return new Date(now.getTime() + env().REFRESH_TOKEN_TTL * 1000);
}
