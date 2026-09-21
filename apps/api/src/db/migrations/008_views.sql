-- ---------------------------------------------------------------------------
-- 008 reporting views
--
-- These wrap the joins that the dashboards and reports would otherwise repeat,
-- so the SQL in the service layer stays short and every consumer agrees on
-- what "planned hours" and "overdue" mean.
-- ---------------------------------------------------------------------------

-- Open, capacity-consuming allocations, one row per (user, task).
CREATE OR REPLACE VIEW v_open_allocations AS
SELECT
  ta.user_id,
  t.id            AS task_id,
  t.key           AS task_key,
  t.team_id,
  t.org_id,
  t.title,
  t.status,
  t.priority,
  t.due_date,
  t.remaining_hours,
  -- Prefer the explicit split; fall back to the task's remaining effort.
  CASE WHEN ta.allocated_hours > 0 THEN ta.allocated_hours ELSE t.remaining_hours END AS planned_hours
FROM task_assignees ta
JOIN tasks t ON t.id = ta.task_id
WHERE t.status NOT IN ('done', 'cancelled');

-- Per-user planned load bucketed into the ISO week a task is due in. Tasks
-- with no due date land in the current week so they are never invisible.
CREATE OR REPLACE VIEW v_user_week_load AS
SELECT
  oa.user_id,
  to_char(coalesce(oa.due_date, CURRENT_DATE), 'IYYY-"W"IW') AS week_key,
  sum(oa.planned_hours)::numeric(8,2) AS planned_hours,
  count(*)                            AS task_count,
  count(*) FILTER (WHERE oa.due_date < CURRENT_DATE) AS overdue_count
FROM v_open_allocations oa
GROUP BY 1, 2;

-- Task completion trend, one row per team per day.
CREATE OR REPLACE VIEW v_task_completion_daily AS
SELECT
  t.team_id,
  t.completed_at::date AS day,
  count(*)             AS completed_count,
  sum(t.logged_hours)::numeric(10,2) AS logged_hours
FROM tasks t
WHERE t.status = 'done' AND t.completed_at IS NOT NULL
GROUP BY 1, 2;

-- Unread counts per (conversation, member) from the read watermark.
CREATE OR REPLACE VIEW v_conversation_unread AS
SELECT
  cm.conversation_id,
  cm.user_id,
  count(m.id) AS unread_count
FROM conversation_members cm
LEFT JOIN messages m
       ON m.conversation_id = cm.conversation_id
      AND m.deleted_at IS NULL
      AND m.author_id <> cm.user_id
      AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)
GROUP BY 1, 2;
