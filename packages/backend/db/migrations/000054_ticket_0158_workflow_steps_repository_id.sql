ALTER TABLE workflow_steps
    ADD COLUMN IF NOT EXISTS repository_id BIGINT REFERENCES repositories(id) ON DELETE CASCADE;

UPDATE workflow_steps AS ws
SET repository_id = wr.repository_id
FROM workflow_runs AS wr
WHERE ws.workflow_run_id = wr.id
  AND ws.repository_id IS NULL;

ALTER TABLE workflow_steps
    ALTER COLUMN repository_id SET NOT NULL;

CREATE OR REPLACE FUNCTION set_workflow_step_repository_id()
RETURNS TRIGGER AS $$
DECLARE
    expected_repository_id BIGINT;
BEGIN
    SELECT repository_id
    INTO expected_repository_id
    FROM workflow_runs
    WHERE id = NEW.workflow_run_id;

    IF expected_repository_id IS NULL THEN
        RAISE EXCEPTION 'workflow_run % not found for workflow_step', NEW.workflow_run_id;
    END IF;

    NEW.repository_id := expected_repository_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_steps_repository_id ON workflow_steps;

CREATE TRIGGER trg_workflow_steps_repository_id
    BEFORE INSERT OR UPDATE ON workflow_steps
    FOR EACH ROW
    EXECUTE FUNCTION set_workflow_step_repository_id();

CREATE INDEX IF NOT EXISTS idx_workflow_steps_repo_run_position
    ON workflow_steps (repository_id, workflow_run_id, position);
