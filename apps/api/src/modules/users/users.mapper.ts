import type { PublicUser, Role } from '@teamspace/shared';

/**
 * One canonical projection of a user row, reused by every query that returns
 * a user so the shape never drifts between endpoints.
 */
export const USER_SELECT = `
  u.id,
  u.org_id,
  u.email,
  u.display_name,
  u.avatar_url,
  u.role,
  u.job_title,
  u.timezone,
  u.weekly_capacity_hours,
  u.manager_id,
  u.is_active,
  COALESCE(
    (SELECT array_agg(s.name::text ORDER BY s.name)
       FROM user_skills us JOIN skills s ON s.id = us.skill_id
      WHERE us.user_id = u.id),
    '{}'
  ) AS skills
`;

export interface UserRow {
  id: string;
  org_id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  role: Role;
  job_title: string | null;
  timezone: string;
  weekly_capacity_hours: string;
  manager_id: string | null;
  is_active: boolean;
  skills: string[];
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    jobTitle: row.job_title,
    timezone: row.timezone,
    // pg returns NUMERIC as a string to avoid precision loss; the API
    // contract is a number.
    weeklyCapacityHours: Number(row.weekly_capacity_hours),
    managerId: row.manager_id,
    isActive: row.is_active,
    skills: row.skills ?? [],
  };
}
