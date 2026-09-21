-- ---------------------------------------------------------------------------
-- 005 capacity, leave and holidays
-- ---------------------------------------------------------------------------

-- Per-week capacity overrides. The absence of a row means "use the user's
-- weekly_capacity_hours", so a steady-state org stores nothing here.
CREATE TABLE capacity_weeks (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_key       TEXT NOT NULL CHECK (week_key ~ '^\d{4}-W\d{2}$'),
  capacity_hours NUMERIC(5,2) NOT NULL CHECK (capacity_hours BETWEEN 0 AND 168),
  note           TEXT,
  updated_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, week_key)
);

CREATE TABLE leave_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          leave_kind NOT NULL DEFAULT 'vacation',
  status        leave_status NOT NULL DEFAULT 'pending',
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  -- Supports half days: 4 hours/day over a range.
  hours_per_day NUMERIC(4,2) NOT NULL DEFAULT 8 CHECK (hours_per_day > 0 AND hours_per_day <= 24),
  note          TEXT,
  decided_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT leave_range_ordered CHECK (start_date <= end_date),
  CONSTRAINT leave_decision_complete CHECK (
    (status IN ('pending', 'cancelled')) OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
);

-- Capacity lookups ask "approved leave overlapping this week", so the index
-- covers the range and skips rejected/cancelled rows.
CREATE INDEX leave_requests_user_range_idx ON leave_requests (user_id, start_date, end_date)
  WHERE status = 'approved';
CREATE INDEX leave_requests_pending_idx ON leave_requests (user_id) WHERE status = 'pending';

CREATE TABLE holidays (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  day     DATE NOT NULL,
  -- Null region means org-wide; otherwise matched against the user's timezone
  -- region grouping.
  region  TEXT,
  hours   NUMERIC(4,2) NOT NULL DEFAULT 8 CHECK (hours > 0 AND hours <= 24),
  UNIQUE (org_id, day, region)
);

CREATE INDEX holidays_org_day_idx ON holidays (org_id, day);
