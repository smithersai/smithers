-- The gVisor runner pool is retired. Every CI run now executes on the sandbox
-- plane, where the sandbox scheduler runs each job in its own NixOS guest, so
-- nothing will ever claim a runner-plane task again. Move every runner-plane
-- run onto the sandbox plane: an unfinished one is picked up by the sandbox
-- scheduler instead of waiting forever, and a finished one can still be
-- resumed.

-- Tasks a runner held when the pool went away return to pending, exactly as
-- the runner coordinator requeued a lost runner's tasks, and so do their
-- running steps. The sandbox scheduler then decides every task from its
-- persisted status.
WITH requeued AS (
    UPDATE workflow_tasks AS wt
    SET status = 'pending',
        runner_id = NULL,
        assigned_at = NULL,
        started_at = NULL,
        available_at = NOW(),
        updated_at = NOW()
    FROM workflow_runs AS wr
    WHERE wr.id = wt.workflow_run_id
      AND wr.execution_plane = 'runner'
      AND wr.status IN ('queued', 'running')
      AND wt.status IN ('assigned', 'running')
    RETURNING wt.workflow_step_id
)
UPDATE workflow_steps AS ws
SET status = 'queued',
    started_at = NULL,
    completed_at = NULL,
    updated_at = NOW()
WHERE ws.id IN (SELECT workflow_step_id FROM requeued)
  AND ws.status = 'running';

-- A runner-plane run is 'running' once its first task was claimed; the
-- sandbox scheduler claims only queued runs (or its own expired leases).
UPDATE workflow_runs
SET status = 'queued',
    updated_at = NOW()
WHERE execution_plane = 'runner'
  AND status = 'running';

-- execution_plane is otherwise immutable. The only move it now permits is off
-- the retired runner plane, onto the sandbox plane that replaced it.
CREATE OR REPLACE FUNCTION public.guard_workflow_run_execution_plane_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.execution_plane IS DISTINCT FROM OLD.execution_plane
       AND NOT (OLD.execution_plane = 'runner' AND NEW.execution_plane = 'sandbox') THEN
        RAISE EXCEPTION 'workflow_run % execution_plane is immutable (% -> %)',
            OLD.id, OLD.execution_plane, NEW.execution_plane
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

UPDATE workflow_runs
SET execution_plane = 'sandbox'
WHERE execution_plane = 'runner';

ALTER TABLE workflow_runs ALTER COLUMN execution_plane SET DEFAULT 'sandbox';

-- Alert remediation runs are CI runs, so they now live on the sandbox plane.
-- Their dispatch-token and incident indexes keep only the trigger predicate.
DROP INDEX idx_workflow_runs_alert_remediation_dispatch_token;
CREATE UNIQUE INDEX idx_workflow_runs_alert_remediation_dispatch_token
    ON workflow_runs ((dispatch_inputs ->> 'remediation_dispatch_token'))
    WHERE trigger_event = 'monitoring_alert'
      AND dispatch_inputs ? 'remediation_dispatch_token';

DROP INDEX idx_workflow_runs_legacy_alert_incident;
CREATE INDEX idx_workflow_runs_legacy_alert_incident
    ON workflow_runs ((dispatch_inputs ->> 'incident_row_id'), (dispatch_inputs ->> 'incident_id'), status)
    WHERE trigger_event = 'monitoring_alert'
      AND NOT (dispatch_inputs ? 'remediation_dispatch_token');
