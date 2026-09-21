-- Ticket 0147: denormalize repository_id onto workflow_steps so the Electric
-- run-inspection shape (ShapeWorkflowRunSteps) can enforce the same
-- `repository_id IN (...)` auth predicate every other production shape uses.
--
-- Why this ticket:
--   - RunInspectView needs STEP-level tree + status data in remote mode; 0111
--     landed ShapeWorkflowRuns for run metadata but left per-run steps on the
--     CLI path, which does not exist remotely.
--   - The electric auth proxy (internal/electric/auth.go) REQUIRES
--     `repository_id IN (...)` in every shape where clause — it walks the
--     per-user read-access gate on the IDs it extracts. `workflow_steps` has
--     only `workflow_run_id` today, so a naive steps shape would fail the
--     parseRepoIDs check before even reaching Electric.
--   - `workflow_tasks` already carries `repository_id` (see schema.sql line
--     806) because it is the runner-claim target, so no schema change is
--     required there for ShapeWorkflowRunTasks.
--
-- Design choice — DB trigger, not Go call-site changes:
--   - `workflow_steps` has many call sites (agent_dispatch, workflow_run
--     scheduler, agent service, integration tests). Rather than thread
--     repository_id through each one — and risk forgetting one, which the
--     Electric proxy would silently miss — this migration installs a
--     BEFORE INSERT trigger that pulls `repository_id` from the parent run.
--   - The Go-side CreateWorkflowStepParams struct stays untouched. sqlc
--     regeneration only adds the new column to the struct's SELECT result
--     mapping (the CreateWorkflowStep query uses `RETURNING *`).
--   - Rationale matches the ticket 0115/0118 denorm contract: "New INSERTs
--     are required to populate the denorm fields" — here, the trigger IS
--     the populator, backed by the workflow_runs FK which every step row
--     already carries NOT NULL.
--
-- Behavior:
--   - Live rows backfilled from `workflow_runs.repository_id` via a one-time
--     UPDATE (every workflow_steps row has NOT NULL workflow_run_id and
--     workflow_runs.repository_id is NOT NULL, so the join is total).
--   - NEW INSERTs get the column populated by trigger BEFORE row land — the
--     sqlc-generated query "INSERT INTO workflow_steps (workflow_run_id,
--     name, position, status) VALUES (...)" need not name the column.
--
-- Forward-only: atlas-managed. atlas.sum regenerated with
-- `atlas migrate hash` after this file lands.

------------------------------------------------------------------------------
-- Ticket 0147: workflow_steps.repository_id
------------------------------------------------------------------------------

-- Step 1: add the column nullable so the backfill can run without a
-- not-null violation on existing rows.
ALTER TABLE workflow_steps
    ADD COLUMN IF NOT EXISTS repository_id BIGINT;

-- Step 2: backfill from the parent run. Every workflow_steps row has a
-- NOT NULL workflow_run_id referencing workflow_runs(id), and every
-- workflow_runs row has a NOT NULL repository_id, so the JOIN is total.
UPDATE workflow_steps s
SET repository_id = r.repository_id
FROM workflow_runs r
WHERE s.workflow_run_id = r.id
  AND s.repository_id IS NULL;

-- Step 3: install the BEFORE INSERT trigger that populates the column for
-- every new row. The function is intentionally defensive — if the caller
-- already populated repository_id (e.g. a future code path that wants to
-- pin it explicitly) we respect it; otherwise we look it up from the
-- parent run.
CREATE OR REPLACE FUNCTION set_workflow_step_repository_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.repository_id IS NULL THEN
        SELECT r.repository_id
        INTO NEW.repository_id
        FROM workflow_runs r
        WHERE r.id = NEW.workflow_run_id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workflow_steps_repository_id ON workflow_steps;
CREATE TRIGGER trg_workflow_steps_repository_id
BEFORE INSERT ON workflow_steps
FOR EACH ROW
EXECUTE FUNCTION set_workflow_step_repository_id();

-- Step 4: lock the invariant in (NOT NULL + FK). The trigger fires BEFORE
-- the NOT NULL check, so new INSERTs that don't supply repository_id still
-- pass once the lookup completes.
ALTER TABLE workflow_steps
    ALTER COLUMN repository_id SET NOT NULL;

ALTER TABLE workflow_steps
    ADD CONSTRAINT workflow_steps_repository_id_fkey
    FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE;

-- Step 5: production-shape index. The Electric where-clause template is
-- `repository_id IN (...) AND workflow_run_id IN (...)`, ordered by
-- (run, position) on the client side; `(repository_id, workflow_run_id,
-- position)` matches directly and lets the planner prune by repo before
-- run.
CREATE INDEX IF NOT EXISTS idx_workflow_steps_repo_run_position
    ON workflow_steps (repository_id, workflow_run_id, position);
