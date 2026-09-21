-- Enforce one queued or running GitHub mirror reconciliation per repository.
-- Settle legacy duplicates before adding the admission constraint so rollout
-- remains safe if overlapping runs were accepted by an older server.
-- smithers:migration-contract-reviewed: bounded metadata reconciliation plus additive index

WITH active_runs AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY repository_id
               ORDER BY created_at DESC, id DESC
           ) AS position
    FROM github_mirror_sync_runs
    WHERE state IN ('queued', 'running')
)
UPDATE github_mirror_sync_runs AS run
SET state = 'failed',
    finished_at = COALESCE(run.finished_at, NOW()),
    updated_at = NOW()
FROM active_runs
WHERE run.id = active_runs.id
  AND active_runs.position > 1;

CREATE UNIQUE INDEX uq_github_mirror_sync_runs_active
    ON github_mirror_sync_runs (repository_id)
    WHERE state IN ('queued', 'running');
