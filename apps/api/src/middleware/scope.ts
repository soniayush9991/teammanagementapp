import type { Role } from '@teamspace/shared';
import { queryOne } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import type { AuthenticatedActor } from './auth.js';

/**
 * The record-level half of authorization. `requirePermission` answers "may
 * this role ever do this?"; these functions answer "for this row?" — team
 * membership, the reporting line, conversation membership. Both must pass.
 */

export async function assertSameOrg(actor: AuthenticatedActor, userId: string): Promise<void> {
  const row = await queryOne<{ id: string }>('SELECT id FROM users WHERE id = $1 AND org_id = $2', [
    userId,
    actor.orgId,
  ]);
  if (!row) throw ApiError.notFound('User');
}

/** True when `userId` reports to the actor directly or further down the tree. */
export async function isInReportingLine(actor: AuthenticatedActor, userId: string): Promise<boolean> {
  if (actor.id === userId) return true;
  const row = await queryOne<{ found: boolean }>(
    `
    WITH RECURSIVE reports AS (
      SELECT id FROM users WHERE manager_id = $1 AND org_id = $2
      UNION
      SELECT u.id FROM users u JOIN reports r ON u.manager_id = r.id WHERE u.org_id = $2
    )
    SELECT EXISTS (SELECT 1 FROM reports WHERE id = $3) AS found
    `,
    [actor.id, actor.orgId, userId],
  );
  return row?.found ?? false;
}

/**
 * Can the actor see this person's workload, capacity and tasks? Admins can
 * see anyone in the org, managers their reportees and team members, and
 * everyone can see themselves.
 */
export async function canViewUser(actor: AuthenticatedActor, userId: string): Promise<boolean> {
  if (actor.role === 'admin') return true;
  if (actor.id === userId) return true;
  if (await isInReportingLine(actor, userId)) return true;
  // Teammates can see each other's basic profile and shared team tasks.
  const row = await queryOne<{ shared: boolean }>(
    `
    SELECT EXISTS (
      SELECT 1
        FROM team_members a
        JOIN team_members b ON a.team_id = b.team_id
       WHERE a.user_id = $1 AND b.user_id = $2
    ) AS shared
    `,
    [actor.id, userId],
  );
  return row?.shared ?? false;
}

export async function assertCanViewUser(actor: AuthenticatedActor, userId: string): Promise<void> {
  await assertSameOrg(actor, userId);
  if (!(await canViewUser(actor, userId))) {
    throw ApiError.forbidden('You cannot view this user');
  }
}

export interface TeamScope {
  teamId: string;
  isManager: boolean;
  isMember: boolean;
}

export async function loadTeamScope(actor: AuthenticatedActor, teamId: string): Promise<TeamScope> {
  const row = await queryOne<{ manager_id: string; is_member: boolean }>(
    `
    SELECT t.manager_id,
           EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id = $2) AS is_member
      FROM teams t
     WHERE t.id = $1 AND t.org_id = $3
    `,
    [teamId, actor.id, actor.orgId],
  );
  if (!row) throw ApiError.notFound('Team');

  const isManager = actor.role === 'admin' || row.manager_id === actor.id;
  return { teamId, isManager, isMember: isManager || row.is_member };
}

export async function assertTeamMember(actor: AuthenticatedActor, teamId: string): Promise<TeamScope> {
  const scope = await loadTeamScope(actor, teamId);
  if (!scope.isMember) throw ApiError.forbidden('You are not a member of this team');
  return scope;
}

export async function assertTeamManager(actor: AuthenticatedActor, teamId: string): Promise<TeamScope> {
  const scope = await loadTeamScope(actor, teamId);
  if (!scope.isManager) throw ApiError.forbidden('Only the team manager can do this');
  return scope;
}

export interface TaskScope {
  taskId: string;
  teamId: string;
  orgId: string;
  createdBy: string | null;
  isAssignee: boolean;
  isTeamManager: boolean;
  isTeamMember: boolean;
}

export async function loadTaskScope(actor: AuthenticatedActor, taskId: string): Promise<TaskScope> {
  // A task is addressable by UUID or by its human key (TS-214).
  const row = await queryOne<{
    id: string;
    team_id: string;
    org_id: string;
    created_by: string | null;
    manager_id: string;
    is_assignee: boolean;
    is_member: boolean;
  }>(
    `
    SELECT t.id, t.team_id, t.org_id, t.created_by, tm2.manager_id,
           EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $2) AS is_assignee,
           EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.team_id AND m.user_id = $2) AS is_member
      FROM tasks t
      JOIN teams tm2 ON tm2.id = t.team_id
     WHERE t.org_id = $3 AND (t.id::text = $1 OR t.key = upper($1))
    `,
    [taskId, actor.id, actor.orgId],
  );
  if (!row) throw ApiError.notFound('Task');

  const isTeamManager = actor.role === 'admin' || row.manager_id === actor.id;
  return {
    taskId: row.id,
    teamId: row.team_id,
    orgId: row.org_id,
    createdBy: row.created_by,
    isAssignee: row.is_assignee,
    isTeamManager,
    isTeamMember: isTeamManager || row.is_member,
  };
}

export async function assertCanReadTask(actor: AuthenticatedActor, taskId: string): Promise<TaskScope> {
  const scope = await loadTaskScope(actor, taskId);
  if (!scope.isTeamMember && !scope.isAssignee) {
    throw ApiError.forbidden('You do not have access to this task');
  }
  return scope;
}

/**
 * Members may edit tasks they created or are assigned to; managers may edit
 * anything in their team. Reassigning is gated separately by the
 * `task:assign` permission.
 */
export async function assertCanWriteTask(actor: AuthenticatedActor, taskId: string): Promise<TaskScope> {
  const scope = await assertCanReadTask(actor, taskId);
  if (scope.isTeamManager || scope.isAssignee || scope.createdBy === actor.id) return scope;
  throw ApiError.forbidden('You can only edit tasks you created or are assigned to');
}

export interface ConversationScope {
  conversationId: string;
  kind: 'dm' | 'group' | 'channel';
  visibility: 'public' | 'private';
  isMember: boolean;
  memberRole: 'owner' | 'admin' | 'member' | null;
}

export async function loadConversationScope(
  actor: AuthenticatedActor,
  conversationId: string,
): Promise<ConversationScope> {
  const row = await queryOne<{
    id: string;
    kind: ConversationScope['kind'];
    visibility: ConversationScope['visibility'];
    member_role: ConversationScope['memberRole'];
  }>(
    `
    SELECT c.id, c.kind, c.visibility, cm.role AS member_role
      FROM conversations c
      LEFT JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2
     WHERE c.id = $1 AND c.org_id = $3
    `,
    [conversationId, actor.id, actor.orgId],
  );
  if (!row) throw ApiError.notFound('Conversation');

  return {
    conversationId: row.id,
    kind: row.kind,
    visibility: row.visibility,
    isMember: row.member_role !== null,
    memberRole: row.member_role,
  };
}

/**
 * Reading a conversation needs membership, with two exceptions: public
 * channels are readable by anyone in the org, and a compliance role holding
 * `conversation:read_any_history` can read private history for audits. DMs
 * are never readable by a non-participant, whatever the role.
 */
export async function assertCanReadConversation(
  actor: AuthenticatedActor,
  conversationId: string,
  options: { forAudit?: boolean } = {},
): Promise<ConversationScope> {
  const scope = await loadConversationScope(actor, conversationId);
  if (scope.isMember) return scope;
  if (scope.kind === 'channel' && scope.visibility === 'public') return scope;
  if (options.forAudit && actor.role === 'admin' && scope.kind !== 'dm') return scope;
  throw ApiError.forbidden('You are not a member of this conversation');
}

export async function assertConversationMember(
  actor: AuthenticatedActor,
  conversationId: string,
): Promise<ConversationScope> {
  const scope = await loadConversationScope(actor, conversationId);
  if (!scope.isMember) throw ApiError.forbidden('You are not a member of this conversation');
  return scope;
}

export async function assertConversationAdmin(
  actor: AuthenticatedActor,
  conversationId: string,
): Promise<ConversationScope> {
  const scope = await assertConversationMember(actor, conversationId);
  if (actor.role === 'admin') return scope;
  if (scope.memberRole === 'owner' || scope.memberRole === 'admin') return scope;
  throw ApiError.forbidden('Only a group owner or admin can do this');
}

export function assertRoleCanBeAssigned(actorRole: Role, targetRole: Role): void {
  // Only admins mint admins; this keeps privilege escalation off the
  // manager path.
  if (targetRole === 'admin' && actorRole !== 'admin') {
    throw ApiError.forbidden('Only an admin can grant the admin role');
  }
}
