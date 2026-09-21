# 8. Database schema

PostgreSQL 16. The authoritative source is
[`apps/api/src/db/migrations/`](../apps/api/src/db/migrations/) — this document
explains the decisions; the SQL is the specification.

Migrations are forward-only and checksummed: editing one that has already been
applied is detected and refused, so environments cannot silently diverge.

| File | Contents |
|---|---|
| `001_foundation.sql` | Extensions, enum types, organizations, retention policies |
| `002_identity.sql` | Users, skills, refresh tokens, audit log |
| `003_teams.sql` | Teams, membership, task-key allocation |
| `004_tasks.sql` | Tasks, assignees, labels, dependencies, comments, activity, work logs |
| `005_capacity.sql` | Weekly overrides, leave, holidays |
| `006_messaging.sql` | Conversations, partitioned messages, reactions, attachments, reads |
| `007_notifications.sql` | Notifications, preferences, reminder deduplication |
| `008_views.sql` | Reporting views |
| `009_leave_decision_constraint.sql` | Relaxes a constraint that blocked user deletion |

## Types

```sql
user_role          admin | manager | member
task_status        backlog | todo | in_progress | in_review | blocked | done | cancelled
task_priority      low | medium | high | urgent
dependency_type    blocks | relates_to | duplicates
recurrence_freq    daily | weekly | biweekly | monthly
conversation_kind  dm | group | channel
conversation_vis   public | private
leave_kind         vacation | sick | holiday | other
leave_status       pending | approved | rejected | cancelled
notification_kind  task_assigned | task_status_changed | task_due_soon | task_overdue
                   | mention | group_invitation | message | comment
```

Enums rather than lookup tables: the set changes about once a year, and a typo
becomes a migration error instead of a silently unmatched row.

## Core tables

### `users`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `org_id` | UUID FK | Cascade delete |
| `email` | CITEXT | Unique per org, case-insensitive |
| `password_hash` | TEXT | bcrypt, cost 12 |
| `role` | `user_role` | Organization-wide |
| `weekly_capacity_hours` | NUMERIC(5,2) | `0–168`, the contracted baseline |
| `manager_id` | UUID FK self | `CHECK (manager_id <> id)` |
| `is_active` | BOOLEAN | Deactivation, never deletion |

Indexes: partial on `(org_id) WHERE is_active`, on `manager_id`, and a GIN
trigram index on `display_name` for typeahead.

### `tasks`

Notable constraints, each of which prevents a real inconsistency:

```sql
CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date)
CHECK ((status = 'done') = (completed_at IS NOT NULL))   -- cannot be done without a timestamp
CHECK ((recurrence_freq IS NULL) = (recurrence_interval IS NULL))
CHECK (parent_task_id <> id)
UNIQUE (org_id, key)                                      -- PLAT-214 is unique and quotable
```

Indexes:

```sql
tasks_team_status_idx  (team_id, status)              -- board columns
tasks_open_due_idx     (due_date) WHERE status NOT IN ('done','cancelled')
                                    AND due_date IS NOT NULL
tasks_search_idx       GIN (search_vector)
tasks_title_trgm_idx   GIN (title gin_trgm_ops)       -- typeahead
```

`tasks_open_due_idx` is partial on purpose: overdue and upcoming-deadline
queries never look at closed work, so the index stays proportional to open
tasks rather than to all history.

`search_vector` is maintained by trigger, with the key and title weighted `A`
and the description `B`, so a search for "PLAT-1" or an exact title outranks an
incidental mention in a description.

### `task_assignees`

`allocated_hours` splits an estimate across several assignees so a 16-hour task
shared by two people consumes 8 hours of each person's capacity rather than 16
of both. When it is zero, the task's `remaining_hours` is used instead.

### `messages` — partitioned

```sql
CREATE TABLE messages (
  id                UUID NOT NULL DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  parent_message_id UUID,                 -- see ER notes: intentionally not an FK
  body              TEXT NOT NULL,
  mentions          UUID[] NOT NULL DEFAULT '{}',
  pinned_at         TIMESTAMPTZ,
  edited_at         TIMESTAMPTZ,
  deleted_at        TIMESTAMPTZ,          -- soft delete keeps thread structure
  search_vector     TSVECTOR,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
```

`ensure_message_partition(date)` creates a month's partition if missing; the
migration runner provisions the current and next month on boot, and the
retention job keeps two months ahead.

**Timestamps are never round-tripped through the application.** PostgreSQL
timestamps carry microseconds and JavaScript `Date` only milliseconds, so
passing a `created_at` back from JS would silently fail the composite foreign
key. Every insert that needs the partition key selects it from the row:

```sql
INSERT INTO message_reactions (message_id, message_created_at, user_id, emoji)
SELECT m.id, m.created_at, $2, $3 FROM messages m WHERE m.id = $1;
```

### `conversations`

```sql
CHECK ((kind = 'dm' AND name IS NULL) OR (kind <> 'dm' AND length(btrim(name)) > 0))
CHECK (kind <> 'dm' OR visibility = 'private')
```

A DM can never be named or made public. Uniqueness of a DM per pair is enforced
by `dm_pairs`, whose `CHECK (user_a < user_b)` forces a canonical ordering.

### `leave_requests`

```sql
CHECK (start_date <= end_date)
CHECK (status IN ('pending','cancelled') OR decided_at IS NOT NULL)
```

The second constraint originally also demanded `decided_by IS NOT NULL`. That
was wrong: `decided_by` is `ON DELETE SET NULL`, so removing a manager nulled
the decider on every leave they had approved and the cascade then failed the
check — deleting a user errored instead of tidying up. Migration 009 relaxed it
to require only `decided_at`, since what matters for capacity is that a
decision was made; *who* made it is best-effort history.

## Reporting views

| View | Purpose |
|---|---|
| `v_open_allocations` | One row per (user, open task) with the hours it consumes |
| `v_user_week_load` | Planned hours and task counts bucketed by ISO week |
| `v_task_completion_daily` | Completed count and logged hours per team per day |
| `v_conversation_unread` | Unread counts derived from the read watermark |

These exist so "planned hours" is defined once in SQL as well as once in
TypeScript.

## Indexing strategy

| Access pattern | Index |
|---|---|
| Board: tasks by team and status | `tasks_team_status_idx` |
| Overdue / upcoming deadlines | `tasks_open_due_idx` (partial) |
| A person's open work | `task_assignees_user_idx` |
| Conversation paging, newest first | `messages_conversation_idx (conversation_id, created_at DESC)` |
| Thread expansion | `messages_thread_idx` (partial, non-null parents) |
| Unread badge | `notifications_unread_idx` (partial, `read_at IS NULL`) |
| Full-text search | GIN on `tasks.search_vector`, `messages.search_vector`, `attachments.search_vector` |
| Typeahead | GIN trigram on `users.display_name`, `tasks.title` |
| Mention fan-out | GIN on `messages.mentions` (UUID array) |
| Leave overlapping a week | `leave_requests_user_range_idx` (partial, approved only) |

Four of these are partial indexes. The pattern is deliberate: index the rows a
query actually touches, so index size tracks *open* work rather than total
history.

## Verification

Applied and exercised against a live PostgreSQL 16 instance. Nine data
integrity rules were confirmed to reject bad rows, including: a `done` task
without `completed_at`, a due date before its start date, a named DM, an
unnamed channel, an unsorted DM pair, an attachment with two owners, a
self-managing user, a malformed week key, and an approved leave with no
decision recorded.
