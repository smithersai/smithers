-- Expand-only: one defaulted text column plus one partial index. No rewrite of
-- existing rows, no change to any existing SELECT/RETURNING row shape beyond
-- the appended column, so previous-version binaries keep working during a
-- rolling deployment.

-- On 2026-09-15 a GitHub-synced repository pushed main seven times in a row.
-- Each push queued a full `ci` run (runs 11751-11757, six grouped tasks each),
-- so 40+ pending tasks piled onto a 3-5 pod runner pool and every other
-- repository's run starved: roninjin10/smithers run 11753 was queued at 16:43Z
-- and still queued an hour later. Nothing cancelled a run that a newer push to
-- the same ref had already superseded. cancel_reason records WHY a run was
-- cancelled ('superseded_by_run:<id>') so the UI can say "Superseded by run
-- 11763" instead of a bare cancelled.
ALTER TABLE workflow_runs
    ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(128) NOT NULL DEFAULT '';

-- Supports the supersede lookup: the newest push run for a ref cancels every
-- older non-terminal run of the same (repository, definition, ref).
CREATE INDEX IF NOT EXISTS idx_workflow_runs_active_by_ref
    ON workflow_runs (repository_id, workflow_definition_id, trigger_ref, id)
    WHERE status IN ('queued', 'running');
