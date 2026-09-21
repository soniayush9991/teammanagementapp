-- ---------------------------------------------------------------------------
-- 006 conversations, messages, reactions, attachments, read receipts
--
-- `messages` is RANGE partitioned by month on created_at. Retention then
-- becomes a metadata operation (DETACH + DROP an old partition) instead of a
-- 365-day bulk DELETE that would bloat the heap and thrash autovacuum.
-- ---------------------------------------------------------------------------

CREATE TABLE conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind            conversation_kind NOT NULL,
  visibility      conversation_vis NOT NULL DEFAULT 'private',
  -- DMs carry no name; groups and channels must have one.
  name            TEXT,
  topic           TEXT,
  team_id         UUID REFERENCES teams(id) ON DELETE SET NULL,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  last_message_at TIMESTAMPTZ,
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversations_named_unless_dm CHECK (
    (kind = 'dm' AND name IS NULL) OR (kind <> 'dm' AND length(btrim(coalesce(name, ''))) > 0)
  ),
  CONSTRAINT conversations_dm_is_private CHECK (kind <> 'dm' OR visibility = 'private')
);

CREATE INDEX conversations_org_recent_idx ON conversations (org_id, last_message_at DESC NULLS LAST);
CREATE INDEX conversations_team_idx       ON conversations (team_id) WHERE team_id IS NOT NULL;
-- Channel directory browsing.
CREATE INDEX conversations_public_idx     ON conversations (org_id, name)
  WHERE visibility = 'public' AND archived_at IS NULL;

CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  -- Read receipts and unread counts are derived from this watermark rather
  -- than a row per message per user.
  last_read_at    TIMESTAMPTZ,
  notify          TEXT NOT NULL DEFAULT 'all' CHECK (notify IN ('all', 'mentions', 'none')),
  invited_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX conversation_members_user_idx ON conversation_members (user_id);

-- Exactly one DM per unordered pair of users. The sorted-pair key is written
-- by the service layer; the unique index makes a race impossible.
CREATE TABLE dm_pairs (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_a          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (org_id, user_a, user_b),
  CONSTRAINT dm_pairs_ordered CHECK (user_a < user_b)
);

CREATE TABLE conversation_task_links (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  linked_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, task_id)
);

CREATE INDEX conversation_task_links_task_idx ON conversation_task_links (task_id);

CREATE TABLE messages (
  id              UUID NOT NULL DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Thread root. Not a foreign key: a self-referencing FK on a partitioned
  -- table would need the parent's created_at carried on every child row.
  -- The service layer validates the parent is in the same conversation.
  parent_message_id UUID,
  body            TEXT NOT NULL,
  -- Denormalized mention list so notification fan-out never re-parses bodies.
  mentions        UUID[] NOT NULL DEFAULT '{}',
  pinned_at       TIMESTAMPTZ,
  pinned_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  edited_at       TIMESTAMPTZ,
  -- Soft delete keeps thread structure intact ("message deleted").
  deleted_at      TIMESTAMPTZ,
  search_vector   TSVECTOR,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Newest-first paging within a conversation.
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at DESC);
CREATE INDEX messages_thread_idx       ON messages (parent_message_id, created_at)
  WHERE parent_message_id IS NOT NULL;
CREATE INDEX messages_author_idx       ON messages (author_id, created_at DESC);
CREATE INDEX messages_mentions_idx     ON messages USING GIN (mentions);
CREATE INDEX messages_search_idx       ON messages USING GIN (search_vector);
CREATE INDEX messages_pinned_idx       ON messages (conversation_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL;

CREATE OR REPLACE FUNCTION messages_search_vector_refresh() RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', coalesce(NEW.body, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER messages_search_vector
  BEFORE INSERT OR UPDATE OF body ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_search_vector_refresh();

-- Keeps conversation ordering fresh without a second round trip per send.
CREATE OR REPLACE FUNCTION messages_touch_conversation() RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversations
     SET last_message_at = GREATEST(coalesce(last_message_at, NEW.created_at), NEW.created_at)
   WHERE id = NEW.conversation_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER messages_touch_conversation_after
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_touch_conversation();

-- Creates the monthly partition covering a date if it is missing. Called by
-- the scheduler (a month ahead) and by migrate on boot.
CREATE OR REPLACE FUNCTION ensure_message_partition(p_day DATE) RETURNS TEXT AS $$
DECLARE
  v_start DATE := date_trunc('month', p_day)::date;
  v_end   DATE := (date_trunc('month', p_day) + INTERVAL '1 month')::date;
  v_name  TEXT := 'messages_' || to_char(v_start, 'YYYY_MM');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF messages FOR VALUES FROM (%L) TO (%L)',
      v_name, v_start, v_end
    );
  END IF;
  RETURN v_name;
END;
$$ LANGUAGE plpgsql;

-- Reactions, attachments and read markers reference the composite message key.
CREATE TABLE message_reactions (
  message_id         UUID NOT NULL,
  message_created_at TIMESTAMPTZ NOT NULL,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji              TEXT NOT NULL CHECK (length(emoji) BETWEEN 1 AND 32),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji),
  FOREIGN KEY (message_id, message_created_at) REFERENCES messages (id, created_at) ON DELETE CASCADE
);

CREATE INDEX message_reactions_message_idx ON message_reactions (message_id);

CREATE TABLE attachments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uploaded_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  -- An attachment hangs off exactly one of: a message, a task, a comment.
  message_id         UUID,
  message_created_at TIMESTAMPTZ,
  task_id            UUID REFERENCES tasks(id) ON DELETE CASCADE,
  comment_id         UUID REFERENCES task_comments(id) ON DELETE CASCADE,
  file_name          TEXT NOT NULL,
  content_type       TEXT NOT NULL,
  byte_size          BIGINT NOT NULL CHECK (byte_size > 0),
  -- Key in the S3-compatible bucket; never served directly, always presigned.
  storage_key        TEXT NOT NULL UNIQUE,
  checksum_sha256    TEXT,
  search_vector      TSVECTOR,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (message_id, message_created_at) REFERENCES messages (id, created_at) ON DELETE CASCADE,
  CONSTRAINT attachments_single_owner CHECK (
    (message_id IS NOT NULL)::int + (task_id IS NOT NULL)::int + (comment_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT attachments_message_key_complete CHECK (
    (message_id IS NULL) = (message_created_at IS NULL)
  )
);

CREATE INDEX attachments_message_idx ON attachments (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX attachments_task_idx    ON attachments (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX attachments_org_idx     ON attachments (org_id, created_at DESC);
CREATE INDEX attachments_search_idx  ON attachments USING GIN (search_vector);

CREATE OR REPLACE FUNCTION attachments_search_vector_refresh() RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', replace(coalesce(NEW.file_name, ''), '.', ' '));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER attachments_search_vector
  BEFORE INSERT OR UPDATE OF file_name ON attachments
  FOR EACH ROW EXECUTE FUNCTION attachments_search_vector_refresh();

-- Per-message read receipts, written only for conversations small enough to
-- want them (DMs and groups under a threshold); larger channels rely on the
-- last_read_at watermark alone.
CREATE TABLE message_reads (
  message_id         UUID NOT NULL,
  message_created_at TIMESTAMPTZ NOT NULL,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id),
  FOREIGN KEY (message_id, message_created_at) REFERENCES messages (id, created_at) ON DELETE CASCADE
);

CREATE INDEX message_reads_user_idx ON message_reads (user_id, read_at DESC);
