import type { Request } from 'express';
import { permissionsForRole, type AuthSession, type PublicUser, type Role } from '@teamspace/shared';
import { query, queryOne, withTransaction } from '../../db/pool.js';
import { env } from '../../env.js';
import { recordAudit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
  signAccessToken,
} from '../../lib/tokens.js';
import { toPublicUser, type UserRow, USER_SELECT } from '../users/users.mapper.js';

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export function contextOf(req: Request): RequestContext {
  return { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

interface IssuedSession {
  session: AuthSession;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  /**
   * False when the refresh token was not rotated (the grace path below), so
   * the caller must leave the client's existing cookie alone rather than
   * overwriting it with an older value.
   */
  rotated: boolean;
}

export async function login(
  email: string,
  password: string,
  context: RequestContext,
): Promise<IssuedSession> {
  const row = await queryOne<UserRow & { password_hash: string; is_active: boolean }>(
    `SELECT ${USER_SELECT}, u.password_hash FROM users u WHERE u.email = $1`,
    [email],
  );

  // Always run a comparison so a missing account and a wrong password take
  // the same time, which keeps the endpoint from enumerating users.
  const passwordHash = row?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const passwordMatches = await verifyPassword(password, passwordHash);

  if (!row || !passwordMatches || !row.is_active) {
    if (row) {
      await recordAudit({
        orgId: row.org_id,
        actorId: row.id,
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: row.id,
        ipAddress: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: !passwordMatches ? 'bad_password' : 'inactive' },
      });
    }
    throw ApiError.unauthorized('Email or password is incorrect');
  }

  const user = toPublicUser(row);
  const issued = await issueSessionForRow(row, user, context);

  await query('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]);
  await recordAudit({
    orgId: row.org_id,
    actorId: user.id,
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    ipAddress: context.ip,
    userAgent: context.userAgent,
  });

  return issued;
}

/** issueSession needs the org id, which only the row carries. */
async function issueSessionForRow(
  row: UserRow,
  user: PublicUser,
  context: RequestContext,
): Promise<IssuedSession> {
  const { token, hash } = generateRefreshToken();
  const expiresAt = refreshTokenExpiry();
  const inserted = await queryOne<{ id: string }>(
    `
    INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
    `,
    [user.id, hash, context.userAgent, context.ip, expiresAt],
  );
  if (!inserted) throw ApiError.internal('Could not start a session');

  return {
    session: {
      accessToken: signAccessToken({ sub: user.id, orgId: row.org_id, role: user.role, sid: inserted.id }),
      expiresIn: env().ACCESS_TOKEN_TTL,
      user,
      permissions: [...permissionsForRole(user.role)],
    },
    refreshToken: token,
    refreshTokenExpiresAt: expiresAt,
    rotated: true,
  };
}

/**
 * Raised when a refresh token that was already rotated is presented again.
 * It is thrown out of the rotation transaction so the caller can revoke the
 * token family on a *separate* connection — revoking inside the transaction
 * that then throws would be undone by the rollback, leaving the stolen token
 * live.
 */
class RefreshReuseError extends Error {
  constructor(readonly userId: string) {
    super('refresh token reuse detected');
  }
}

/**
 * How long after a rotation the previous token is still accepted.
 *
 * Without this, any client that fires two refreshes before the first
 * response lands — a double-submitted form, a reconnecting socket, React's
 * development double-effect — would look identical to a stolen token and
 * log the user out of every session. A genuine thief replaying a token
 * days later is still caught; a race measured in milliseconds is not.
 */
const ROTATION_GRACE_SECONDS = 10;

async function revokeAllSessions(userId: string, context: RequestContext): Promise<void> {
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
    userId,
  ]);
  logger.warn({ userId }, 'refresh token reuse detected, revoked every session for the account');

  const user = await queryOne<{ org_id: string }>('SELECT org_id FROM users WHERE id = $1', [userId]);
  if (user) {
    await recordAudit({
      orgId: user.org_id,
      actorId: userId,
      action: 'auth.refresh_reuse_detected',
      entityType: 'user',
      entityId: userId,
      ipAddress: context.ip,
      userAgent: context.userAgent,
    });
  }
}

/**
 * Rotating refresh: the presented token is revoked and replaced on every use.
 * If a token that was already rotated is presented again it has leaked, so
 * the entire token family is revoked and the user must sign in again.
 */
export async function refresh(presentedToken: string, context: RequestContext): Promise<IssuedSession> {
  const hash = hashRefreshToken(presentedToken);

  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query<{
        id: string;
        user_id: string;
        revoked_at: Date | null;
        replaced_by: string | null;
        expires_at: Date;
      }>(
        `SELECT id, user_id, revoked_at, replaced_by, expires_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
        [hash],
      );
      const token = rows[0];
      if (!token) throw ApiError.unauthorized('Refresh token is not recognised');

      if (token.revoked_at || token.replaced_by) {
        // Inside the grace window, hand back the session the replacement
        // token already represents instead of assuming theft.
        const rotatedAt = token.revoked_at?.getTime() ?? 0;
        const withinGrace = Date.now() - rotatedAt <= ROTATION_GRACE_SECONDS * 1000;
        const { rows: replacementRows } = await client.query<{ id: string; revoked_at: Date | null }>(
          'SELECT id, revoked_at FROM refresh_tokens WHERE id = $1',
          [token.replaced_by],
        );
        const replacement = replacementRows[0];

        if (!withinGrace || !replacement || replacement.revoked_at) {
          throw new RefreshReuseError(token.user_id);
        }

        const { rows: graceUserRows } = await client.query<UserRow>(
          `SELECT ${USER_SELECT} FROM users u WHERE u.id = $1 AND u.is_active`,
          [token.user_id],
        );
        const graceUserRow = graceUserRows[0];
        if (!graceUserRow) throw ApiError.unauthorized('Account is inactive');

        const graceUser = toPublicUser(graceUserRow);
        return {
          session: {
            accessToken: signAccessToken({
              sub: graceUser.id,
              orgId: graceUserRow.org_id,
              role: graceUser.role,
              sid: replacement.id,
            }),
            expiresIn: env().ACCESS_TOKEN_TTL,
            user: graceUser,
            permissions: [...permissionsForRole(graceUser.role)],
          },
          // The client already holds the rotated cookie from the request
          // that won the race; leave it in place.
          refreshToken: presentedToken,
          refreshTokenExpiresAt: token.expires_at,
          rotated: false,
        };
      }

      if (token.expires_at.getTime() <= Date.now()) {
        throw ApiError.unauthorized('Refresh token has expired');
      }

      const { rows: userRows } = await client.query<UserRow>(
        `SELECT ${USER_SELECT} FROM users u WHERE u.id = $1 AND u.is_active`,
        [token.user_id],
      );
      const userRow = userRows[0];
      if (!userRow) throw ApiError.unauthorized('Account is inactive');

      const next = generateRefreshToken();
      const expiresAt = refreshTokenExpiry();
      const { rows: insertedRows } = await client.query<{ id: string }>(
        `
        INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        `,
        [userRow.id, next.hash, context.userAgent, context.ip, expiresAt],
      );
      const inserted = insertedRows[0];
      if (!inserted) throw ApiError.internal('Could not rotate the session');

      await client.query(`UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1`, [
        token.id,
        inserted.id,
      ]);

      const user = toPublicUser(userRow);
      return {
        session: {
          accessToken: signAccessToken({
            sub: user.id,
            orgId: userRow.org_id,
            role: user.role,
            sid: inserted.id,
          }),
          expiresIn: env().ACCESS_TOKEN_TTL,
          user,
          permissions: [...permissionsForRole(user.role)],
        },
        refreshToken: next.token,
        refreshTokenExpiresAt: expiresAt,
        rotated: true,
      };
    });
  } catch (error) {
    if (error instanceof RefreshReuseError) {
      // Outside the rolled-back transaction, so the revocation sticks.
      await revokeAllSessions(error.userId, context);
      throw ApiError.unauthorized('Session revoked, please sign in again');
    }
    throw error;
  }
}

export async function logout(presentedToken: string | undefined, userId: string | null): Promise<void> {
  if (presentedToken) {
    await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [
      hashRefreshToken(presentedToken),
    ]);
    return;
  }
  if (userId) {
    await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [
      userId,
    ]);
  }
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  context: RequestContext,
): Promise<void> {
  const row = await queryOne<{ password_hash: string; org_id: string }>(
    'SELECT password_hash, org_id FROM users WHERE id = $1',
    [userId],
  );
  if (!row) throw ApiError.notFound('User');
  if (!(await verifyPassword(currentPassword, row.password_hash))) {
    throw ApiError.unauthorized('Current password is incorrect');
  }

  const hash = await hashPassword(newPassword);
  await withTransaction(async (client) => {
    await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash]);
    // Changing a password ends every other session.
    await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
      userId,
    ]);
    await recordAudit(
      {
        orgId: row.org_id,
        actorId: userId,
        action: 'auth.password_changed',
        entityType: 'user',
        entityId: userId,
        ipAddress: context.ip,
        userAgent: context.userAgent,
      },
      client,
    );
  });
}

export async function currentSession(userId: string): Promise<{ user: PublicUser; permissions: string[] }> {
  const row = await queryOne<UserRow>(`SELECT ${USER_SELECT} FROM users u WHERE u.id = $1`, [userId]);
  if (!row) throw ApiError.notFound('User');
  const user = toPublicUser(row);
  return { user, permissions: [...permissionsForRole(user.role as Role)] };
}
