-- Revision: 20260718000000.
-- Dual-executor race fix: the Freestyle whole-workflow scheduler claimed any
-- queued workflow_run while the gVisor runner independently claimed the same
-- run's pending workflow_tasks, so one standard CI run could execute on both
-- planes. execution_plane is the single authoritative run-level discriminator:
--   'runner'  — standard CI; only the GKE/gVisor task runner claims its tasks
--   'sandbox' — explicitly-created internal sandbox runs; only the Freestyle
--               whole-workflow scheduler claims the run. Workflow YAML does
--               not select this plane: product CI always uses the runner.
--   'agent'   — agent runs; driven solely by agent dispatch, claimable by
--               neither queue consumer
ALTER TABLE workflow_runs
    ADD COLUMN IF NOT EXISTS execution_plane VARCHAR(16);

-- Deterministic backfill for pre-existing rows: agent-sentinel definitions are
-- 'agent'; every CI definition belongs to the runner plane. In particular,
-- runs-on is workflow metadata, not an execution-plane selector. PRODUCT_DESIGN
-- reserves Freestyle VMs for agents and workspaces and requires CI workflow
-- steps to remain on the task-queue runner infrastructure.
UPDATE workflow_runs wr
SET execution_plane = CASE
    WHEN EXISTS (
        SELECT 1
        FROM workflow_definitions wd
        WHERE wd.id = wr.workflow_definition_id
          AND wd.path = '.smithers/agent'
    ) THEN 'agent'
    ELSE 'runner'
END
WHERE wr.execution_plane IS NULL;

-- Orphan-proof fallback (workflow_definition_id is NOT NULL + FK, so this is
-- expected to update zero rows; kept so SET NOT NULL below can never fail).
UPDATE workflow_runs
SET execution_plane = 'runner'
WHERE execution_plane IS NULL;

ALTER TABLE workflow_runs
    ALTER COLUMN execution_plane SET DEFAULT 'runner';
ALTER TABLE workflow_runs
    ALTER COLUMN execution_plane SET NOT NULL;
ALTER TABLE workflow_runs
    ADD CONSTRAINT workflow_runs_execution_plane_check
    CHECK (execution_plane IN ('runner', 'sandbox', 'agent'));

-- Old binaries omit execution_plane when inserting runs. The runner default is
-- correct for ordinary CI, but agent sentinel definitions must never enter a
-- claimable runner queue during a rolling deployment.
CREATE OR REPLACE FUNCTION force_agent_workflow_run_execution_plane()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM workflow_definitions wd
        WHERE wd.id = NEW.workflow_definition_id
          AND wd.path = '.smithers/agent'
    ) THEN
        NEW.execution_plane := 'agent';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_runs_10_force_agent_plane ON workflow_runs;

CREATE TRIGGER trg_workflow_runs_10_force_agent_plane
    BEFORE INSERT ON workflow_runs
    FOR EACH ROW
    EXECUTE FUNCTION force_agent_workflow_run_execution_plane();

-- A run's executor is selected once, at insert. Allowing a claimed row to
-- switch planes would make it eligible for a second consumer even though all
-- claim queries filter correctly.
CREATE OR REPLACE FUNCTION guard_workflow_run_execution_plane_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.execution_plane IS DISTINCT FROM OLD.execution_plane THEN
        RAISE EXCEPTION 'workflow_run % execution_plane is immutable (% -> %)',
            OLD.id, OLD.execution_plane, NEW.execution_plane
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_runs_20_execution_plane_immutable ON workflow_runs;

CREATE TRIGGER trg_workflow_runs_20_execution_plane_immutable
    BEFORE UPDATE OF execution_plane ON workflow_runs
    FOR EACH ROW
    EXECUTE FUNCTION guard_workflow_run_execution_plane_immutable();

-- Previous releases' whole-workflow scheduler updated every queued run without
-- an execution-plane predicate. During rolling overlap, silently skip its
-- runner/agent rows. New aggregate status updates set a transaction-local
-- marker bound to one exact run ID; sandbox claims remain valid without it.
CREATE OR REPLACE FUNCTION guard_workflow_run_status_claim()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'queued'
       AND NEW.status = 'running'
       AND OLD.execution_plane IS DISTINCT FROM 'sandbox'
       AND current_setting('smithers.workflow_run_status_id', true)
           IS DISTINCT FROM OLD.id::text THEN
        RETURN NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_runs_30_status_claim_guard ON workflow_runs;

CREATE TRIGGER trg_workflow_runs_30_status_claim_guard
    BEFORE UPDATE OF status ON workflow_runs
    FOR EACH ROW
    EXECUTE FUNCTION guard_workflow_run_status_claim();

-- Claim-order index for the Freestyle whole-workflow scheduler's
-- ClaimQueuedWorkflowRuns (status = 'queued' AND execution_plane = 'sandbox'
-- ORDER BY created_at, id).
CREATE INDEX idx_workflow_runs_sandbox_claim
    ON workflow_runs (created_at ASC, id ASC)
    WHERE status = 'queued' AND execution_plane = 'sandbox';

-- Keep workflow_tasks' denormalized authorization scope tied to its actual
-- parent step/run. The canonical schema already carries this trigger, but the
-- migration history previously omitted it, so migration-built production
-- databases allowed direct INSERT/UPDATE statements to pair independently
-- valid run, step, and repository IDs.
CREATE OR REPLACE FUNCTION set_workflow_task_repository_id()
RETURNS TRIGGER AS $$
DECLARE
    step_run_id BIGINT;
    step_repository_id BIGINT;
BEGIN
    SELECT workflow_run_id, repository_id
    INTO step_run_id, step_repository_id
    FROM workflow_steps
    WHERE id = NEW.workflow_step_id;

    IF step_repository_id IS NULL THEN
        RAISE EXCEPTION 'workflow_step % not found for workflow_task', NEW.workflow_step_id;
    END IF;
    IF step_run_id <> NEW.workflow_run_id THEN
        RAISE EXCEPTION 'workflow_task run % does not match run % of workflow_step %',
            NEW.workflow_run_id, step_run_id, NEW.workflow_step_id;
    END IF;

    NEW.repository_id := step_repository_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_tasks_repository_id ON workflow_tasks;

CREATE TRIGGER trg_workflow_tasks_repository_id
    BEFORE INSERT OR UPDATE ON workflow_tasks
    FOR EACH ROW
    EXECUTE FUNCTION set_workflow_task_repository_id();

-- Previous task runners did not join workflow_runs when claiming pending
-- tasks. Skip wrong-plane pending->assigned claims, and also prevent a task
-- assigned just before this migration from advancing on the wrong executor.
-- Agent VM dispatch is the sole legitimate non-runner assigned->running path:
-- it carries a VM ID and no runner ownership.
CREATE OR REPLACE FUNCTION guard_workflow_task_execution_plane_claim()
RETURNS TRIGGER AS $$
DECLARE
    parent_execution_plane VARCHAR(16);
BEGIN
    IF NOT (
        (OLD.status = 'pending' AND NEW.status = 'assigned')
        OR (OLD.status = 'assigned' AND NEW.status = 'running')
    ) THEN
        RETURN NEW;
    END IF;

    SELECT execution_plane
    INTO parent_execution_plane
    FROM workflow_runs
    WHERE id = OLD.workflow_run_id;

    IF OLD.status = 'pending' AND NEW.status = 'assigned' THEN
        IF parent_execution_plane IS DISTINCT FROM 'runner'
           OR NEW.runner_id IS NULL THEN
            RETURN NULL;
        END IF;
        RETURN NEW;
    END IF;

    IF parent_execution_plane = 'runner' THEN
        IF NEW.runner_id IS NULL THEN
            RETURN NULL;
        END IF;
        RETURN NEW;
    END IF;

    IF parent_execution_plane = 'agent'
       AND OLD.runner_id IS NULL
       AND NEW.runner_id IS NULL
       AND NEW.vm_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_tasks_20_execution_plane_claim_guard ON workflow_tasks;

CREATE TRIGGER trg_workflow_tasks_20_execution_plane_claim_guard
    BEFORE UPDATE OF status ON workflow_tasks
    FOR EACH ROW
    EXECUTE FUNCTION guard_workflow_task_execution_plane_claim();
