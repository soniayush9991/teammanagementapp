import type { Team } from '@teamspace/shared';
import { queryOne, queryRows, withTransaction } from '../../db/pool.js';
import { recordAudit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import type { AuthenticatedActor } from '../../middleware/auth.js';
import { assertSameOrg, assertTeamManager, loadTeamScope } from '../../middleware/scope.js';

interface TeamRow {
  id: string;
  name: string;
  description: string | null;
  manager_id: string;
  member_count: string;
  created_at: Date;
}

const TEAM_SELECT = `
  t.id, t.name, t.description, t.manager_id, t.created_at,
  (SELECT count(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count
`;

function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    managerId: row.manager_id,
    memberCount: Number(row.member_count),
    createdAt: row.created_at.toISOString(),
  };
}

/** Admins see every team; everyone else sees the teams they belong to or manage. */
export async function listTeams(actor: AuthenticatedActor): Promise<Team[]> {
  const rows =
    actor.role === 'admin'
      ? await queryRows<TeamRow>(
          `SELECT ${TEAM_SELECT} FROM teams t WHERE t.org_id = $1 AND t.archived_at IS NULL ORDER BY t.name`,
          [actor.orgId],
        )
      : await queryRows<TeamRow>(
          `
          SELECT ${TEAM_SELECT}
            FROM teams t
           WHERE t.org_id = $1
             AND t.archived_at IS NULL
             AND (t.manager_id = $2 OR EXISTS (
                   SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id = $2))
           ORDER BY t.name
          `,
          [actor.orgId, actor.id],
        );
  return rows.map(toTeam);
}

export async function getTeam(actor: AuthenticatedActor, teamId: string): Promise<Team> {
  await loadTeamScope(actor, teamId);
  const row = await queryOne<TeamRow>(`SELECT ${TEAM_SELECT} FROM teams t WHERE t.id = $1 AND t.org_id = $2`, [
    teamId,
    actor.orgId,
  ]);
  if (!row) throw ApiError.notFound('Team');
  return toTeam(row);
}

export interface CreateTeamInput {
  name: string;
  description?: string;
  keyPrefix: string;
  managerId?: string;
  memberIds?: string[];
}

export async function createTeam(actor: AuthenticatedActor, input: CreateTeamInput): Promise<Team> {
  // A manager creating a team owns it unless an admin names someone else.
  const managerId = input.managerId ?? actor.id;
  if (managerId !== actor.id && actor.role !== 'admin') {
    throw ApiError.forbidden('Only an admin can create a team for someone else');
  }
  await assertSameOrg(actor, managerId);

  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `
      INSERT INTO teams (org_id, name, description, manager_id, key_prefix)
      VALUES ($1, $2, $3, $4, upper($5))
      RETURNING id
      `,
      [actor.orgId, input.name, input.description ?? null, managerId, input.keyPrefix],
    );
    const created = rows[0];
    if (!created) throw ApiError.internal('Could not create the team');

    // The manager is always a member of their own team.
    const memberIds = [...new Set([managerId, ...(input.memberIds ?? [])])];
    await client.query(
      `
      INSERT INTO team_members (team_id, user_id, role_in_team)
      SELECT $1, u.id, CASE WHEN u.id = $2 THEN 'manager' ELSE 'member' END
        FROM users u
       WHERE u.org_id = $3 AND u.id = ANY($4::uuid[])
      ON CONFLICT DO NOTHING
      `,
      [created.id, managerId, actor.orgId, memberIds],
    );

    await recordAudit(
      {
        orgId: actor.orgId,
        actorId: actor.id,
        action: 'team.created',
        entityType: 'team',
        entityId: created.id,
        metadata: { name: input.name, managerId },
      },
      client,
    );

    const { rows: teamRows } = await client.query<TeamRow>(`SELECT ${TEAM_SELECT} FROM teams t WHERE t.id = $1`, [
      created.id,
    ]);
    const teamRow = teamRows[0];
    if (!teamRow) throw ApiError.internal('Could not load the created team');
    return toTeam(teamRow);
  });
}

export async function updateTeam(
  actor: AuthenticatedActor,
  teamId: string,
  input: { name?: string; description?: string | null; managerId?: string },
): Promise<Team> {
  await assertTeamManager(actor, teamId);
  if (input.managerId) {
    if (actor.role !== 'admin') throw ApiError.forbidden('Only an admin can hand a team to another manager');
    await assertSameOrg(actor, input.managerId);
  }

  const updates: string[] = [];
  const params: unknown[] = [teamId, actor.orgId];
  if (input.name !== undefined) {
    params.push(input.name);
    updates.push(`name = $${params.length}`);
  }
  if (input.description !== undefined) {
    params.push(input.description);
    updates.push(`description = $${params.length}`);
  }
  if (input.managerId !== undefined) {
    params.push(input.managerId);
    updates.push(`manager_id = $${params.length}`);
  }
  if (updates.length === 0) return getTeam(actor, teamId);

  await withTransaction(async (client) => {
    await client.query(`UPDATE teams SET ${updates.join(', ')} WHERE id = $1 AND org_id = $2`, params);
    if (input.managerId) {
      await client.query(
        `
        INSERT INTO team_members (team_id, user_id, role_in_team) VALUES ($1, $2, 'manager')
        ON CONFLICT (team_id, user_id) DO UPDATE SET role_in_team = 'manager'
        `,
        [teamId, input.managerId],
      );
    }
    await recordAudit(
      {
        orgId: actor.orgId,
        actorId: actor.id,
        action: 'team.updated',
        entityType: 'team',
        entityId: teamId,
        metadata: { changes: input },
      },
      client,
    );
  });

  return getTeam(actor, teamId);
}

export async function archiveTeam(actor: AuthenticatedActor, teamId: string): Promise<void> {
  await assertTeamManager(actor, teamId);
  const open = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM tasks WHERE team_id = $1 AND status NOT IN ('done','cancelled')`,
    [teamId],
  );
  if (Number(open?.count ?? 0) > 0) {
    throw ApiError.conflict('Close or move the open tasks in this team before archiving it', {
      openTasks: Number(open?.count ?? 0),
    });
  }
  await withTransaction(async (client) => {
    await client.query('UPDATE teams SET archived_at = now() WHERE id = $1 AND org_id = $2', [teamId, actor.orgId]);
    await recordAudit(
      { orgId: actor.orgId, actorId: actor.id, action: 'team.archived', entityType: 'team', entityId: teamId },
      client,
    );
  });
}

export interface TeamMember {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  jobTitle: string | null;
  roleInTeam: string;
  skills: string[];
  weeklyCapacityHours: number;
  joinedAt: string;
}

export async function listMembers(actor: AuthenticatedActor, teamId: string): Promise<TeamMember[]> {
  await loadTeamScope(actor, teamId);
  const rows = await queryRows<{
    user_id: string;
    display_name: string;
    avatar_url: string | null;
    job_title: string | null;
    role_in_team: string;
    weekly_capacity_hours: string;
    joined_at: Date;
    skills: string[];
  }>(
    `
    SELECT tm.user_id, u.display_name, u.avatar_url, u.job_title, tm.role_in_team,
           u.weekly_capacity_hours, tm.joined_at,
           COALESCE((SELECT array_agg(s.name::text ORDER BY s.name)
                       FROM user_skills us JOIN skills s ON s.id = us.skill_id
                      WHERE us.user_id = u.id), '{}') AS skills
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = $1 AND u.is_active
     ORDER BY u.display_name
    `,
    [teamId],
  );

  return rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    jobTitle: row.job_title,
    roleInTeam: row.role_in_team,
    skills: row.skills ?? [],
    weeklyCapacityHours: Number(row.weekly_capacity_hours),
    joinedAt: row.joined_at.toISOString(),
  }));
}

export async function addMembers(
  actor: AuthenticatedActor,
  teamId: string,
  userIds: string[],
  roleInTeam: 'lead' | 'member' = 'member',
): Promise<TeamMember[]> {
  await assertTeamManager(actor, teamId);
  await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `
      INSERT INTO team_members (team_id, user_id, role_in_team)
      SELECT $1, u.id, $2 FROM users u WHERE u.org_id = $3 AND u.id = ANY($4::uuid[]) AND u.is_active
      ON CONFLICT (team_id, user_id) DO NOTHING
      `,
      [teamId, roleInTeam, actor.orgId, userIds],
    );
    if (!rowCount) throw ApiError.badRequest('None of those users could be added to the team');
    await recordAudit(
      {
        orgId: actor.orgId,
        actorId: actor.id,
        action: 'team.members_added',
        entityType: 'team',
        entityId: teamId,
        metadata: { userIds, roleInTeam },
      },
      client,
    );
  });
  return listMembers(actor, teamId);
}

export async function removeMember(actor: AuthenticatedActor, teamId: string, userId: string): Promise<void> {
  const scope = await assertTeamManager(actor, teamId);
  const team = await queryOne<{ manager_id: string }>('SELECT manager_id FROM teams WHERE id = $1', [teamId]);
  if (team?.manager_id === userId) {
    throw ApiError.unprocessable('The team manager cannot be removed; hand the team over first');
  }

  const openTasks = await queryOne<{ count: string }>(
    `
    SELECT count(*)::text AS count
      FROM task_assignees ta
      JOIN tasks t ON t.id = ta.task_id
     WHERE ta.user_id = $1 AND t.team_id = $2 AND t.status NOT IN ('done','cancelled')
    `,
    [userId, teamId],
  );
  if (Number(openTasks?.count ?? 0) > 0) {
    throw ApiError.conflict('Reassign this person\'s open tasks before removing them from the team', {
      openTasks: Number(openTasks?.count ?? 0),
    });
  }

  await withTransaction(async (client) => {
    await client.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [scope.teamId, userId]);
    await recordAudit(
      {
        orgId: actor.orgId,
        actorId: actor.id,
        action: 'team.member_removed',
        entityType: 'team',
        entityId: teamId,
        metadata: { userId },
      },
      client,
    );
  });
}
