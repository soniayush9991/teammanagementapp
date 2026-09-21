-- ---------------------------------------------------------------------------
-- 004 tasks, subtasks, assignments, labels, dependencies, comments, activity
-- ---------------------------------------------------------------------------

CREATE TABLE tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id          UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  key              TEXT NOT NULL,
  -- Subtasks are tasks with a parent. One level is enforced in the service
  -- layer (a subtask cannot itself have children).
  parent_task_id   UUID REFERENCES tasks(id) ON DELETE CASCADE,
  title            TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  description      TEXT,
  status           task_status NOT NULL DEFAULT 'todo',
  priority         task_priority NOT NULL DEFAULT 'medium',
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  start_date       DATE,
  due_date         DATE,
  estimated_hours  NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (estimated_hours >= 0),
  -- Remaining effort drives capacity planning and is what members update.
  remaining_hours  NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (remaining_hours >= 0),
  logged_hours     NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (logged_hours >= 0),
  completed_at     TIMESTAMPTZ,
  -- Recurring task template fields; null for one-off tasks.
  recurrence_freq     recurrence_freq,
  recurrence_interval SMALLINT CHECK (recurrence_interval IS NULL OR recurrence_interval BETWEEN 1 AND 52),
  recurrence_until    DATE,
  recurrence_next_at  TIMESTAMPTZ,
  -- Populated by trigger; GIN-indexed for full-text search.
  search_vector    TSVECTOR,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, key),
  CONSTRAINT tasks_dates_ordered CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date),
  CONSTRAINT tasks_done_has_timestamp CHECK ((status = 'done') = (completed_at IS NOT NULL)),
  CONSTRAINT tasks_recurrence_complete CHECK (
    (recurrence_freq IS NULL AND recurrence_interval IS NULL)
    OR (recurrence_freq IS NOT NULL AND recurrence_interval IS NOT NULL)
  ),
  CONSTRAINT tasks_parent_not_self CHECK (parent_task_id IS NULL OR parent_task_id <> id)
);

CREATE INDEX tasks_team_status_idx  ON tasks (team_id, status);
CREATE INDEX tasks_parent_idx       ON tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;
-- Partial index: overdue and upcoming-deadline queries only ever look at
-- tasks that are still open, so the index stays small as history grows.
CREATE INDEX tasks_open_due_idx     ON tasks (due_date)
  WHERE status NOT IN ('done', 'cancelled') AND due_date IS NOT NULL;
CREATE INDEX tasks_recurrence_idx   ON tasks (recurrence_next_at)
  WHERE recurrence_next_at IS NOT NULL;
CREATE INDEX tasks_search_idx       ON tasks USING GIN (search_vector);
CREATE INDEX tasks_title_trgm_idx   ON tasks USING GIN (title gin_trgm_ops);

CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Title carries more weight than description in ranking (A vs B).
CREATE OR REPLACE FUNCTION tasks_search_vector_refresh() RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
      setweight(to_tsvector('english', coalesce(NEW.key, '')), 'A')
   || setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A')
   || setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_search_vector
  BEFORE INSERT OR UPDATE OF key, title, description ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_search_vector_refresh();

-- A task can be assigned to several people; allocated_hours splits the
-- estimate so capacity is not double counted across assignees.
CREATE TABLE task_assignees (
  task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  allocated_hours NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (allocated_hours >= 0),
  assigned_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id)
);

CREATE INDEX task_assignees_user_idx ON task_assignees (user_id);

-- Immutable record of who was assigned what and when, kept even after the
-- assignment is moved elsewhere (powers the assignment history report).
CREATE TABLE assignment_events (
  id          BIGSERIAL PRIMARY KEY,
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL CHECK (action IN ('assigned', 'unassigned', 'reassigned')),
  from_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX assignment_events_task_idx ON assignment_events (task_id, created_at DESC);
CREATE INDEX assignment_events_user_idx ON assignment_events (user_id, created_at DESC);

CREATE TABLE labels (
  id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name   CITEXT NOT NULL,
  color  TEXT NOT NULL DEFAULT '#6366f1' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  UNIQUE (org_id, name)
);

CREATE TABLE task_labels (
  task_id  UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);

CREATE INDEX task_labels_label_idx ON task_labels (label_id);

CREATE TABLE task_dependencies (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id            UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type               dependency_type NOT NULL DEFAULT 'blocks',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, depends_on_task_id, type),
  -- Direct self-dependency is rejected here; longer cycles are rejected by a
  -- recursive check in the service layer before insert.
  CONSTRAINT task_dependencies_no_self CHECK (task_id <> depends_on_task_id)
);

CREATE INDEX task_dependencies_depends_idx ON task_dependencies (depends_on_task_id);

CREATE TABLE task_comments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL CHECK (length(btrim(body)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX task_comments_task_idx ON task_comments (task_id, created_at);

-- Field-level change log rendered as the task's activity timeline.
CREATE TABLE task_activity (
  id         BIGSERIAL PRIMARY KEY,
  task_id    UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  field      TEXT,
  from_value TEXT,
  to_value   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX task_activity_task_idx ON task_activity (task_id, created_at DESC);

-- Time actually spent, which keeps "actual workload" honest next to plan.
CREATE TABLE work_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hours      NUMERIC(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  logged_on  DATE NOT NULL,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX work_logs_user_date_idx ON work_logs (user_id, logged_on);
CREATE INDEX work_logs_task_idx      ON work_logs (task_id);
