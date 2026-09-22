-- Private cluster queries kept separate from the product graph.

-- name: ListReadySandboxEnvironmentImageReferences :many
SELECT image
FROM sandbox_environment_images
WHERE status = 'ready'
ORDER BY image;


-- name: ListProtectedWorkerSnapshotLocalIDs :many
-- The one-hour handoff protects a provider snapshot while the API service is
-- persisting its workspace/golden owner after the controller created it.
SELECT DISTINCT ss.provider_local_id
FROM sandbox_snapshots ss
WHERE ss.worker_id = sqlc.arg(worker_id)::text
  AND ss.deleted_at IS NULL
  AND ss.state NOT IN ('deleting', 'deleted')
  AND (
    ss.state IN ('creating', 'exporting')
    OR ss.updated_at > NOW() - INTERVAL '1 hour'
    OR EXISTS (
        SELECT 1 FROM sandbox_instances i
        WHERE i.deleted_at IS NULL
          AND (i.snapshot_id = ss.id OR i.recovery_snapshot_id = ss.id)
    )
    OR EXISTS (SELECT 1 FROM workspace_snapshots ws WHERE ws.snapshot_id = ss.id)
    OR EXISTS (SELECT 1 FROM sandbox_golden_snapshots gs WHERE gs.snapshot_id = ss.id)
  )
ORDER BY ss.provider_local_id;


-- name: GetLatestReadySandboxEnvironmentImage :one
-- repository_id NULL selects the platform base image for the kind.
SELECT *
FROM sandbox_environment_images
WHERE COALESCE(repository_id, 0) = COALESCE(sqlc.narg(repository_id)::bigint, 0)
  AND kind = sqlc.arg(kind)::text
  AND status = 'ready'
ORDER BY created_at DESC
LIMIT 1;


-- name: ListSandboxEnvironmentImages :many
SELECT *
FROM sandbox_environment_images
WHERE COALESCE(repository_id, 0) = COALESCE(sqlc.narg(repository_id)::bigint, 0)
ORDER BY created_at DESC
LIMIT 100;


-- name: RetireSandboxEnvironmentImage :one
UPDATE sandbox_environment_images
SET status = 'retired', updated_at = NOW()
WHERE id = $1
  AND COALESCE(repository_id, 0) = COALESCE(sqlc.narg(repository_id)::bigint, 0)
RETURNING *;
