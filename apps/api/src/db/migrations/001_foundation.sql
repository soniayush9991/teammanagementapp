-- ---------------------------------------------------------------------------
-- 001 foundation: extensions, enum types, organizations, retention policy
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- fuzzy / prefix search

CREATE TYPE user_role          AS ENUM ('admin', 'manager', 'member');
CREATE TYPE task_status        AS ENUM ('backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled');
CREATE TYPE task_priority      AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TYPE dependency_type    AS ENUM ('blocks', 'relates_to', 'duplicates');
CREATE TYPE recurrence_freq    AS ENUM ('daily', 'weekly', 'biweekly', 'monthly');
CREATE TYPE conversation_kind  AS ENUM ('dm', 'group', 'channel');
CREATE TYPE conversation_vis   AS ENUM ('public', 'private');
CREATE TYPE leave_kind         AS ENUM ('vacation', 'sick', 'holiday', 'other');
CREATE TYPE leave_status       AS ENUM ('pending', 'approved', 'rejected', 'cancelled');
CREATE TYPE notification_kind  AS ENUM (
  'task_assigned', 'task_status_changed', 'task_due_soon', 'task_overdue',
  'mention', 'group_invitation', 'message', 'comment'
);

CREATE TABLE organizations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  slug                CITEXT NOT NULL UNIQUE,
  -- Org-wide defaults; a user row may override the capacity.
  default_weekly_capacity_hours NUMERIC(5,2) NOT NULL DEFAULT 40 CHECK (default_weekly_capacity_hours BETWEEN 0 AND 168),
  timezone            TEXT NOT NULL DEFAULT 'UTC',
  -- Public channels are joinable by anyone; some orgs want them invite-only.
  allow_member_group_creation BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retention is configurable per data class so legal can tighten messages
-- without touching task history. Messages default to the 365-day requirement.
CREATE TABLE retention_policies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope          TEXT NOT NULL CHECK (scope IN ('messages', 'attachments', 'notifications', 'audit_logs')),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  -- When false the purge job reports what it *would* delete without deleting.
  enforced       BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by     UUID,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, scope)
);

-- Reused by every table that carries updated_at.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
