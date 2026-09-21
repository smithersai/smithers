-- Revision: 20260727000000.
-- workflow_tasks.status gained two DAG lifecycle states when dependent and
-- conditional jobs landed: 'blocked' (the job declares `needs` and waits for
-- its dependencies) and 'skipped' (the job's `if` expression evaluated false
-- at dispatch). db/schema.sql was updated to accept both, and the queries in
-- db/queries/workflows.sql (UnblockDependentTasks, the active-task tallies,
-- the run-cancel sweep) read and write them -- but no migration ever widened
-- workflow_tasks_status_check, which still carried the 000001_baseline list
-- of ('pending','assigned','running','done','failed','cancelled').
--
-- Databases created from db/schema.sql (local dev, `zig build test-db`) were
-- therefore permissive, while databases built from the migration chain
-- (production) rejected every dependent or conditional task with SQLSTATE
-- 23514. Dispatch aborts on the first such job, so ANY workflow whose DAG has
-- a job with `needs` could not be dispatched at all in production. The
-- scheduled canary (schedule spec 3, `*/5 * * * *`) has exactly one such job,
-- `notify-failure` (needs: every probe; if: failure()), so the production
-- canary silently stopped dispatching -- monitoring was degraded with nobody
-- being notified.
--
-- smithers:migration-contract-reviewed: release owner @williamcory, replacing the status check is expand-only -- it only widens an accepted-value list, rewrites no rows, and old binaries keep working because they only ever write the six original states.
ALTER TABLE workflow_tasks
    DROP CONSTRAINT IF EXISTS workflow_tasks_status_check;

ALTER TABLE workflow_tasks
    ADD CONSTRAINT workflow_tasks_status_check
    CHECK (status IN ('pending', 'assigned', 'running', 'done', 'failed', 'cancelled', 'blocked', 'skipped'));
