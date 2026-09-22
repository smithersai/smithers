-- Private cluster queries kept separate from the product graph.

-- name: UpsertRunner :one
INSERT INTO runner_pool (name, status, last_heartbeat_at, metadata)
VALUES (sqlc.arg(name), 'idle', NOW(), sqlc.arg(metadata))
ON CONFLICT (name) DO UPDATE
SET status = CASE
                 WHEN runner_pool.status IN ('busy', 'draining') THEN runner_pool.status
                 ELSE 'idle'
             END,
    metadata = EXCLUDED.metadata,
    last_heartbeat_at = NOW(),
    updated_at = NOW()
RETURNING *;


-- name: TouchRunnerHeartbeat :one
UPDATE runner_pool
SET last_heartbeat_at = NOW(),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;


-- name: GetRunnerStatus :one
-- Used only to preserve the HTTP claim contract after an atomic claim returns
-- no task: an idle runner means an empty/contended queue, while a missing,
-- busy, draining, or offline runner is not available for a new claim.
SELECT status
FROM runner_pool
WHERE id = sqlc.arg(id);


-- name: ClaimIdleRunner :one
UPDATE runner_pool
SET status = 'busy',
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND status = 'idle'
RETURNING *;


-- name: ReleaseRunner :execrows
UPDATE runner_pool rp
SET status = 'idle',
    updated_at = NOW()
WHERE rp.id = sqlc.arg(id)
  AND rp.status = 'busy'
  AND NOT EXISTS (
      SELECT 1
      FROM workflow_tasks wt
      WHERE wt.runner_id = rp.id
        AND wt.status IN ('assigned', 'running')
  );


-- name: TerminateRunner :one
UPDATE runner_pool
SET status = 'offline',
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND status <> 'offline'
RETURNING *;


-- name: ListStaleRunners :many
SELECT *
FROM runner_pool
WHERE status IN ('idle', 'busy', 'draining')
  AND last_heartbeat_at IS NOT NULL
  AND last_heartbeat_at < sqlc.arg(cutoff_at)
ORDER BY id;


-- name: ClaimAvailableRunner :one
WITH candidate AS (
    SELECT id
    FROM runner_pool
    WHERE status = 'idle'
      AND last_heartbeat_at IS NOT NULL
      AND last_heartbeat_at > NOW() - sqlc.arg(max_staleness)::interval
    ORDER BY id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
UPDATE runner_pool rp
SET status = 'busy',
    updated_at = NOW()
FROM candidate
WHERE rp.id = candidate.id
RETURNING rp.*;


-- name: ListRunners :many
SELECT *
FROM runner_pool
WHERE (
        sqlc.arg(status_filter)::text = ''
        OR status = sqlc.arg(status_filter)::text
    )
ORDER BY id DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);


-- name: CountRunners :one
SELECT COUNT(*) AS count
FROM runner_pool
WHERE (
        sqlc.arg(status_filter)::text = ''
        OR status = sqlc.arg(status_filter)::text
    );


-- name: CleanupStaleRunners :execrows
UPDATE runner_pool
SET status = 'offline',
    updated_at = NOW()
WHERE status IN ('idle', 'busy')
  AND last_heartbeat_at IS NOT NULL
  AND last_heartbeat_at < NOW() - sqlc.arg(stale_interval)::interval;
