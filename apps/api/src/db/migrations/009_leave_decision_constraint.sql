-- ---------------------------------------------------------------------------
-- 009 relax the leave decision constraint
--
-- `leave_requests.decided_by` is ON DELETE SET NULL, so removing a manager
-- nulls the decider on every leave they ever approved. The original
-- constraint demanded a non-null decider for any decided row, which made that
-- cascade fail: deleting a user (or an organization, which cascades to its
-- users) errored with a check violation instead of tidying up.
--
-- The fact that matters for capacity is that a decision was *made*, which
-- decided_at records. Who made it is best-effort history and may legitimately
-- become unknown once the account is gone.
-- ---------------------------------------------------------------------------

ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_decision_complete;

ALTER TABLE leave_requests
  ADD CONSTRAINT leave_decision_complete CHECK (
    status IN ('pending', 'cancelled') OR decided_at IS NOT NULL
  );
