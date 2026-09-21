-- ---------------------------------------------------------------------------
-- 007 notifications and delivery preferences
-- ---------------------------------------------------------------------------

CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        notification_kind NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  -- In-app deep link, e.g. /tasks/TS-214 or /chat/<conversation-id>.
  link        TEXT,
  entity_type TEXT,
  entity_id   TEXT,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  read_at     TIMESTAMPTZ,
  -- Email fan-out state; null when the channel is off for this user/kind.
  email_queued_at TIMESTAMPTZ,
  email_sent_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The bell badge query: unread, newest first, for one user.
CREATE INDEX notifications_unread_idx ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX notifications_user_idx   ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_email_queue_idx ON notifications (email_queued_at)
  WHERE email_queued_at IS NOT NULL AND email_sent_at IS NULL;

-- One row per (user, kind); a missing row means "use the defaults".
CREATE TABLE notification_preferences (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     notification_kind NOT NULL,
  in_app   BOOLEAN NOT NULL DEFAULT TRUE,
  email    BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (user_id, kind)
);

-- Suppresses duplicate due-soon/overdue reminders: one row per task per
-- reminder kind per day.
CREATE TABLE notification_dedupe (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        notification_kind NOT NULL,
  entity_id   TEXT NOT NULL,
  day         DATE NOT NULL,
  PRIMARY KEY (user_id, kind, entity_id, day)
);
