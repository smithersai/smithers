-- Keep append tasks invisible to old workers; an old reaper cannot convert them
-- into ordinary tasks and silently publish the mythical stack.
ALTER TABLE landing_tasks ADD COLUMN append_request JSONB;
ALTER TABLE landing_tasks DROP CONSTRAINT landing_tasks_status_check;
ALTER TABLE landing_tasks ADD CONSTRAINT landing_tasks_status_check
  CHECK (status IN ('pending', 'append_pending', 'running', 'done', 'failed'));
ALTER TABLE landing_tasks ADD CONSTRAINT landing_tasks_append_dispatch CHECK (
  (append_request IS NULL AND status <> 'append_pending') OR
  (append_request IS NOT NULL AND jsonb_typeof(append_request) = 'object' AND status <> 'pending')
);
DROP INDEX idx_landing_tasks_status_priority;
CREATE INDEX idx_landing_tasks_status_priority ON landing_tasks (status, priority DESC, created_at ASC)
  WHERE status IN ('pending', 'append_pending');
