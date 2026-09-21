-- ---------------------------------------------------------------------------
-- 002 identity: users, skills, sessions, audit trail
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email                 CITEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  display_name          TEXT NOT NULL CHECK (length(btrim(display_name)) > 0),
  avatar_url            TEXT,
  role                  user_role NOT NULL DEFAULT 'member',
  job_title             TEXT,
  timezone              TEXT NOT NULL DEFAULT 'UTC',
  weekly_capacity_hours NUMERIC(5,2) NOT NULL DEFAULT 40 CHECK (weekly_capacity_hours BETWEEN 0 AND 168),
  -- Self-referencing reporting line. A manager's reportees are the rows
  -- pointing at them, which is what "my reportees" queries walk.
  manager_id            UUID REFERENCES users(id) ON DELETE SET NULL,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, email),
  CONSTRAINT users_manager_not_self CHECK (manager_id IS NULL OR manager_id <> id)
);

CREATE INDEX users_org_active_idx  ON users (org_id) WHERE is_active;
CREATE INDEX users_manager_idx     ON users (manager_id) WHERE manager_id IS NOT NULL;
CREATE INDEX users_name_trgm_idx   ON users USING GIN (display_name gin_trgm_ops);

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Skills are a controlled vocabulary so the assignment recommender can match
-- on identity rather than on free text.
CREATE TABLE skills (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name     CITEXT NOT NULL,
  category TEXT,
  UNIQUE (org_id, name)
);

CREATE TABLE user_skills (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id    UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  proficiency SMALLINT NOT NULL DEFAULT 3 CHECK (proficiency BETWEEN 1 AND 5),
  PRIMARY KEY (user_id, skill_id)
);

CREATE INDEX user_skills_skill_idx ON user_skills (skill_id);

-- Refresh tokens are stored hashed and rotated on every use, so a stolen
-- token is single-use and detectable (see security doc: reuse detection).
CREATE TABLE refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  -- Rotation chain: the token that replaced this one.
  replaced_by   UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  user_agent    TEXT,
  ip_address    INET,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_tokens_expiry_idx ON refresh_tokens (expires_at);

CREATE TABLE audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,              -- e.g. 'task.assign', 'user.role_change'
  entity_type  TEXT NOT NULL,              -- e.g. 'task', 'user', 'conversation'
  entity_id    TEXT,
  ip_address   INET,
  user_agent   TEXT,
  -- Before/after payloads for anything a compliance reviewer would ask about.
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_org_created_idx  ON audit_logs (org_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx        ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx       ON audit_logs (entity_type, entity_id);
