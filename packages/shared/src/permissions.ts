import type { Role } from './domain.js';

/**
 * Permission strings are `<resource>:<action>`. RBAC is evaluated in two steps:
 *  1. does the role hold the permission at all (this matrix), and
 *  2. is the actor in scope for the concrete record (team membership,
 *     manager-of relationship, conversation membership) — enforced in the
 *     service layer because scope needs the database.
 */
export const PERMISSIONS = [
  'org:configure',
  'user:read',
  'user:create',
  'user:update',
  'user:deactivate',
  'role:assign',
  'audit:read',
  'retention:configure',

  'team:read',
  'team:create',
  'team:update',
  'team:delete',
  'team:manage_members',

  'task:read',
  'task:create',
  'task:update',
  'task:delete',
  'task:assign',
  'task:update_progress',
  'task:bulk_assign',

  'capacity:read_self',
  'capacity:read_team',
  'capacity:update_self',
  'capacity:update_team',

  'leave:request',
  'leave:approve',

  'conversation:read',
  'conversation:create_group',
  'conversation:create_channel',
  'conversation:manage_members',
  'conversation:pin_message',
  'conversation:read_any_history',

  'message:send',
  'message:edit_own',
  'message:delete_own',
  'message:delete_any',

  'report:read_self',
  'report:read_team',
  'report:export',

  'notification:read_self',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const MEMBER_PERMISSIONS: Permission[] = [
  'user:read',
  'team:read',
  'task:read',
  'task:create',
  'task:update',
  'task:update_progress',
  'capacity:read_self',
  'capacity:update_self',
  'leave:request',
  'conversation:read',
  'conversation:create_group',
  'conversation:manage_members',
  'conversation:pin_message',
  'message:send',
  'message:edit_own',
  'message:delete_own',
  'report:read_self',
  'notification:read_self',
];

const MANAGER_PERMISSIONS: Permission[] = [
  ...MEMBER_PERMISSIONS,
  'team:create',
  'team:update',
  'team:manage_members',
  'task:assign',
  'task:delete',
  'task:bulk_assign',
  'capacity:read_team',
  'capacity:update_team',
  'leave:approve',
  'conversation:create_channel',
  'report:read_team',
  'report:export',
];

/** Admins hold every permission; the matrix stays explicit for auditability. */
const ADMIN_PERMISSIONS: Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  member: MEMBER_PERMISSIONS,
  manager: MANAGER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
};

const ROLE_PERMISSION_SETS: Record<Role, ReadonlySet<Permission>> = {
  member: new Set(MEMBER_PERMISSIONS),
  manager: new Set(MANAGER_PERMISSIONS),
  admin: new Set(ADMIN_PERMISSIONS),
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSION_SETS[role].has(permission);
}

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}
