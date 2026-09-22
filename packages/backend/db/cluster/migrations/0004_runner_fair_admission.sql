-- Keep the per-repository runner admission check independent of task history.
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_active_repo
    ON workflow_tasks (repository_id)
    WHERE status IN ('assigned', 'running');

-- Lock the run before checking its task state. Each statement in this
-- VOLATILE function takes a fresh READ COMMITTED snapshot, including after a
-- competing claim releases the run lock. The marker and claim share that lock.
CREATE OR REPLACE FUNCTION runner_queue_timeout_admissible(
    candidate_run_id bigint,
    candidate_repository_id bigint
) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    expired boolean;
BEGIN
    PERFORM 1 FROM workflow_runs wr
    WHERE wr.id = candidate_run_id
      AND wr.repository_id = candidate_repository_id
      AND wr.execution_plane = 'runner'
      AND wr.status IN ('queued', 'running')
    FOR UPDATE OF wr;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    SELECT EXISTS (
        SELECT 1 FROM workflow_tasks wt
        WHERE wt.workflow_run_id = candidate_run_id
          AND wt.status = 'pending'
          AND wt.available_at <= NOW() - INTERVAL '120 seconds'
    ) AND NOT EXISTS (
        SELECT 1 FROM workflow_tasks wt
        WHERE wt.workflow_run_id = candidate_run_id
          AND wt.status IN ('assigned', 'running')
    ) INTO expired;
    RETURN expired;
END;
$$;

-- VOLATILE SQL inside PL/pgSQL takes a fresh READ COMMITTED snapshot after
-- ClaimRunnerWorkflowTask wins its nonblocking advisory transaction gate.
-- Counting inline in the claim statement would reuse its old snapshot and
-- let concurrent claimers overfill the reserved slot.
CREATE OR REPLACE FUNCTION runner_claim_admissible(
    candidate_repository_id bigint,
    candidate_manual boolean,
    gate_acquired boolean
) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    repository_active bigint;
    background_active bigint;
BEGIN
    IF NOT gate_acquired THEN
        RETURN false;
    END IF;
    SELECT COUNT(*) INTO repository_active
    FROM workflow_tasks active
    JOIN workflow_runs active_run ON active_run.id = active.workflow_run_id
    WHERE active.repository_id = candidate_repository_id
      AND active.status IN ('assigned', 'running')
      AND active_run.execution_plane = 'runner';
    IF repository_active >= 3 THEN
        RETURN false;
    END IF;
    IF candidate_manual THEN
        RETURN true;
    END IF;
    SELECT COUNT(*) INTO background_active
    FROM workflow_tasks active
    JOIN workflow_runs active_run ON active_run.id = active.workflow_run_id
    WHERE active.status IN ('assigned', 'running')
      AND active_run.execution_plane = 'runner'
      AND active_run.trigger_event NOT IN ('manual_dispatch', 'workflow_dispatch');
    RETURN background_active < 3;
END;
$$;
