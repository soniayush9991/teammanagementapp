import type { PublicUser, Role } from '@teamspace/shared';
import { query, queryOne, queryRows, withTransaction } from '../../db/pool.js';
import { recordAudit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import type { AuthenticatedActor } from '../../middleware/auth.js';
import { assertCanViewUser, assertRoleCanBeAssigned, isInReportingLine } from '../../middleware/scope.js';
import { toPublicUser, USER_SELECT, type UserRow } from './users.mapper.js';

export interface ListUsersFilter {
  search?: string;
  role?: Role;
  teamId?: string;
  managerId?: string;
  includeInactive?: boolean;
  limit: number;
  offset: number;
}

export async function listUsers(actor: AuthenticatedActor, filter: ListUsersFilter): Promise<PublicUser[]> {
  const conditions = ['u.org_id = $1'];
  const params: unknown[] = [actor.orgId];

  if (!filter.includeInactive) conditions.push('u.is_active');
  if (filter.search) {
    params.push(`%${filter.search}%`);
    conditions.push(`(u.display_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
  }
  if (filter.role) {
    params.push(filter.role);
    conditions.push(`u.role = $${params.length}::user_role`);
  }
  if (filter.managerId) {
    params.push(filter.managerId);
    conditions.push(`u.manager_id = $${params.length}`);
  }
  if (filter.teamId) {
    params.push(filter.teamId);
    conditions.push(`EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = u.id AND tm.team_id = $${params.length})`);
  }

  params.push(filter.limit, filter.offset);
  const rows = await queryRows<UserRow>(
    `
    SELECT ${USER_SELECT}
      FROM users u
     WHERE ${conditions.join(' AND ')}
     ORDER BY u.display_name
     LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  return rows.map(toPublicUser);
}

export async function getUser(actor: AuthenticatedActor, userId: string): Promise<PublicUser> {
  await assertCanViewUser(actor, userId);
  const row = await queryOne<UserRow>(`SELECT ${USER_SELECT} FROM users u WHERE u.id = $1 AND u.org_id = $2`, [
    userId,
    actor.orgId,
  ]);
  if (!row) throw ApiError.notFound('User');
  return toPublicUser(row);
}

/** Direct reports, which is the list a manager's dashboard is built on. */
export async function listReportees(actor: AuthenticatedActor, managerId: string): Promise<PublicUser[]> {
  if (managerId !== actor.id && actor.role !== 'admin' && !(await isInReportingLine(actor, managerId))) {
    throw ApiError.forbidden('You cannot view this reporting line');
  }
  const rows = await queryRows<UserRow>(
    `SELECT ${USER_SELECT} FROM users u WHERE u.manager_id = $1 AND u.org_id = $2 AND u.is_active ORDER BY u.display_name`,
    [managerId, actor.orgId],
  );
  return rows.map(toPublicUser);
}

export interface CreateUserInput {
  email: string;
  password: string;
  displayName: string;
  role: Role;
  jobTitle?: string;
  timezone?: string;
  weeklyCapacityHours?: number;
  managerId?: string | null;
  skills?: string[];
}

export async function createUser(actor: AuthenticatedActor, input: CreateUserInput): Promise<PublicUser> {
  assertRoleCanBeAssigned(actor.role, input.role);
  const passwordHash = await hashPassword(input.password);

  return withTransaction(async (client) => {
    const existing = await client.query('SELECT 1 FROM users WHERE org_id = $1 AND email = $2', [
      actor.orgId,
      input.email,
    ]);
    if (existing.rowCount && existing.rowCount > 0) {
      throw ApiError.conflict('A user with that email already exists');
    }

    const { rows } = await client.query<{ id: string }>(
      `
      INSERT INTO users (org_id, email, password_hash, display_name, role, job_title, timezone,
                         weekly_capacity_hours, manager_id)
      VALUES ($1, $2, $3, $4, $5::user_role, $6, COALESCE($7, 'UTC'), COALESCE($8, 40), $9)
      RETURNING id
      `,
      [
        actor.orgId,
        input.email,
        passwordHash,
        input.displayName,
        input.role,
        input.jobTitle ?? null,
        input.timezone ?? null,
        input.weeklyCapacityHours ?? null,
        input.managerId ?? null,
      ],
    );
    const created = rows[0];
    if (!created) throw ApiError.internal('Could not create the user');

    if (input.skills?.length) {
      await replaceSkills(client, actor.orgId, created.id, input.skills);
    }

    await recordAudit(
      {
        orgId: actor.orgId,
        actorId: actor.id,
        action: 'user.created',
        entityType: 'user',
        entityId: created.id,
        metadata: { email: input.email, role: input.role },
      },
      client,
    );

    const { rows: userRows } = await client.query<UserRow>(`SELECT ${USER_SELECT} FROM users u WHERE u.id = $1`, [
      created.id,
    ]);
    const userRow = userRows[0];
    if (!userRow) throw ApiError.internal('Could not load the created user');
    return toPublicUser(userRow);
  });
}

export interface UpdateUserInput {
  displayName?: string;
  avatarUrl?: string | null;
  jobTitle?: string | null;
  timezone?: string;
  weeklyCapacityHours?: number;
  managerId?: string | null;
  role?: Role;
  isActive?: boolean;
  skills?: string[];
}

/**
 * Field-level authorization: a person edits their own profile and skills; a
 * manager edits their reportees' capacity and reporting line; only an admin
 * changes roles or deactivates accounts.
 */
export async function updateUser(
  actor: AuthenticatedActor,
  userId: string,
  input: UpdateUserInput,
): Promise<PublicUser> {
  const isSelf = actor.id === userId;
  const managesTarget = actor.role === 'admin' || (await isInReportingLine(actor, userId));
  if (!isSelf && !managesTarget) throw ApiError.forbidden('You cannot edit this user');

  const adminOnly = input.role !== undefined || input.isActive !== undefined;
  if (adminOnly && actor.role !== 'admin') {
    throw ApiError.forbidden('Only an admin can change roles or account status');
  }
  if (input.role) assertRoleCanBeAssigned(actor.role, input.role);

  const managerOnly = input.weeklyCapacityHours !== undefined || input.managerId !== undefined;
  if (managerOnly && !managesTarget) {
    throw ApiError.forbidden('Only a manager or admin can change capacity or the reporting line');
  }
  if (input.managerId === userId) throw ApiError.unprocessable('A user cannot be their own manager');
  if (input.managerId) {
    // Prevent a cycle: the proposed manager must not report to this user.
    const cycle = await queryOne<{ cycle: boolean }>(
      `
      WITH RECURSIVE chain AS (
        SELECT id, manager_id FROM users WHERE id = $1
        UNION ALL
        SELECT u.id, u.manager_id FROM users u JOIN chain c ON u.id = c.manager_id
      )
      SELECT EXISTS (SELECT 1 FROM chain WHERE id = $2) AS cycle
      `,
      [input.managerId, userId],
    );
    if (cycle?.cycle) throw ApiError.unprocessable('That change would create a reporting-line cycle');
  }

  const updates: string[] = [];
  const params: unknown[] = [userId, actor.orgId];
  const push = (fragment: string, value: unknown): void => {
    params.push(value);
    updates.push(fragment.replace('?', `$${params.length}`));
  };

  if (input.displayName !== undefined) push('display_name = ?', input.displayName);
  if (input.avatarUrl !== undefined) push('avatar_url = ?', input.avatarUrl);
  if (input.jobTitle !== undefined) push('job_title = ?', input.jobTitle);
  if (input.timezone !== undefined) push('timezone = ?', input.timezone);
  if (input.weeklyCapacityHours !== undefined) push('weekly_capacity_hours = ?', input.weeklyCapacityHours);
  if (input.managerId !== undefined) push('manager_id = ?', input.managerId);
  if (input.role !== undefined) push('role = ?::user_role', input.role);
  if (input.isActive !== undefined) push('is_active = ?', input.isActive);

  return withTransaction(async (client) => {
    if (updates.length > 0) {
      const { rowCount } = await client.query(
        `UPDATE users SET ${updates.join(', ')} WHERE id = $1 AND org_id = $2`,
        params,
      );
      if (!rowCount) throw ApiError.notFound('User');
    }

    if (input.skills) {
      if (!isSelf && !managesTarget) throw ApiError.forbidden('You cannot edit this user\'s skills');
      await replaceSkills(client, actor.orgId, userId, input.skills);
    }

    // Deactivation and role changes end live sessions immediately.
    if (input.isActive === false || input.role !== undefined) {
      await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
        userId,
      ]);
    }

    await recordAudit(
      {
        orgId: actor.orgId,
        actorId: actor.id,
        action: input.role ? 'user.role_changed' : input.isActive === false ? 'user.deactivated' : 'user.updated',
        entityType: 'user',
        entityId: userId,
        metadata: { changes: input },
      },
      client,
    );

    const { rows } = await client.query<UserRow>(`SELECT ${USER_SELECT} FROM users u WHERE u.id = $1`, [userId]);
    const row = rows[0];
    if (!row) throw ApiError.notFound('User');
    return toPublicUser(row);
  });
}

/** Skills are upserted into the org vocabulary, then re-linked wholesale. */
async function replaceSkills(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  orgId: string,
  userId: string,
  skills: string[],
): Promise<void> {
  const names = [...new Set(skills.map((skill) => skill.trim()).filter(Boolean))];
  await client.query('DELETE FROM user_skills WHERE user_id = $1', [userId]);
  if (names.length === 0) return;

  await client.query(
    `
    INSERT INTO skills (org_id, name)
    SELECT $1, unnest($2::text[])
    ON CONFLICT (org_id, name) DO NOTHING
    `,
    [orgId, names],
  );
  await client.query(
    `
    INSERT INTO user_skills (user_id, skill_id)
    SELECT $1, s.id FROM skills s WHERE s.org_id = $2 AND s.name = ANY($3::citext[])
    ON CONFLICT DO NOTHING
    `,
    [userId, orgId, names],
  );
}

export async function listSkills(actor: AuthenticatedActor): Promise<{ name: string; userCount: number }[]> {
  const rows = await queryRows<{ name: string; user_count: string }>(
    `
    SELECT s.name::text AS name, count(us.user_id) AS user_count
      FROM skills s
      LEFT JOIN user_skills us ON us.skill_id = s.id
     WHERE s.org_id = $1
     GROUP BY s.name
     ORDER BY s.name
    `,
    [actor.orgId],
  );
  return rows.map((row) => ({ name: row.name, userCount: Number(row.user_count) }));
}

export async function deactivateUser(actor: AuthenticatedActor, userId: string): Promise<void> {
  if (actor.id === userId) throw ApiError.unprocessable('You cannot deactivate your own account');
  const owns = await queryOne<{ teams: string }>(
    'SELECT count(*)::text AS teams FROM teams WHERE manager_id = $1 AND archived_at IS NULL',
    [userId],
  );
  if (Number(owns?.teams ?? 0) > 0) {
    throw ApiError.conflict('Reassign the teams this person manages before deactivating them');
  }
  await updateUser(actor, userId, { isActive: false });
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}
