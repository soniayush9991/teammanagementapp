-- ---------------------------------------------------------------------------
-- 003 teams and membership
-- ---------------------------------------------------------------------------

CREATE TABLE teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  description TEXT,
  -- The accountable manager. Deleting the user is blocked until the team is
  -- handed over, which is deliberate: a team must always have an owner.
  manager_id  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Task keys are TS-1, TS-2 ... per team; this is the counter.
  key_prefix  TEXT NOT NULL CHECK (key_prefix ~ '^[A-Z][A-Z0-9]{1,9}$'),
  task_seq    INTEGER NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name),
  UNIQUE (org_id, key_prefix)
);

CREATE INDEX teams_org_idx     ON teams (org_id) WHERE archived_at IS NULL;
CREATE INDEX teams_manager_idx ON teams (manager_id);

CREATE TRIGGER teams_updated_at BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE team_members (
  team_id      UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Team-local role: a member can be a lead in one team and a member in
  -- another without changing their org-level role.
  role_in_team TEXT NOT NULL DEFAULT 'member' CHECK (role_in_team IN ('manager', 'lead', 'member')),
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX team_members_user_idx ON team_members (user_id);

-- Atomically hands out the next task key for a team.
CREATE OR REPLACE FUNCTION next_task_key(p_team_id UUID) RETURNS TEXT AS $$
DECLARE
  v_prefix TEXT;
  v_seq    INTEGER;
BEGIN
  UPDATE teams
     SET task_seq = task_seq + 1
   WHERE id = p_team_id
  RETURNING key_prefix, task_seq INTO v_prefix, v_seq;

  IF v_prefix IS NULL THEN
    RAISE EXCEPTION 'unknown team %', p_team_id;
  END IF;

  RETURN v_prefix || '-' || v_seq;
END;
$$ LANGUAGE plpgsql;
