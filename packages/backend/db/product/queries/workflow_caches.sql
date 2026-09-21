-- Product queries extracted from the transitional Plue source.

-- name: GetWorkflowCacheByID :one
SELECT *
FROM workflow_caches
WHERE id = sqlc.arg(id);


-- name: GetWorkflowCacheByScopeVersion :one
SELECT *
FROM workflow_caches
WHERE repository_id = sqlc.arg(repository_id)
  AND bookmark_name = sqlc.arg(bookmark_name)
  AND cache_key = sqlc.arg(cache_key)
  AND cache_version = sqlc.arg(cache_version)
LIMIT 1;


-- name: FindWorkflowCacheForRestore :one
SELECT *
FROM workflow_caches
WHERE repository_id = sqlc.arg(repository_id)
  AND status = 'finalized'
  AND expires_at > NOW()
  AND cache_key = sqlc.arg(cache_key)
  AND cache_version = sqlc.arg(cache_version)
  AND bookmark_name IN (sqlc.arg(bookmark_name), sqlc.arg(default_bookmark))
ORDER BY
    CASE
        WHEN bookmark_name = sqlc.arg(bookmark_name) THEN 0
        ELSE 1
    END,
    finalized_at DESC NULLS LAST,
    id DESC
LIMIT 1;


-- name: UpsertPendingWorkflowCache :one
WITH candidate AS (
    SELECT
        sqlc.arg(repository_id)::bigint AS repository_id,
        sqlc.narg(workflow_run_id)::bigint AS workflow_run_id,
        sqlc.arg(bookmark_name)::text AS bookmark_name,
        sqlc.arg(cache_key)::text AS cache_key,
        sqlc.arg(cache_version)::text AS cache_version,
        sqlc.arg(object_key)::text AS object_key,
        sqlc.arg(object_size_bytes)::bigint AS object_size_bytes,
        sqlc.arg(compression)::text AS compression,
        sqlc.arg(expires_at)::timestamptz AS expires_at
    WHERE sqlc.narg(workflow_run_id)::bigint IS NULL
       OR EXISTS (
           SELECT 1
           FROM workflow_runs AS wr
           WHERE wr.id = sqlc.narg(workflow_run_id)::bigint
             AND wr.repository_id = sqlc.arg(repository_id)::bigint
       )
),
upserted AS (
    INSERT INTO workflow_caches (
        repository_id,
        workflow_run_id,
        bookmark_name,
        cache_key,
        cache_version,
        object_key,
        object_size_bytes,
        compression,
        status,
        expires_at
    )
    SELECT
        candidate.repository_id,
        candidate.workflow_run_id,
        candidate.bookmark_name,
        candidate.cache_key,
        candidate.cache_version,
        candidate.object_key,
        candidate.object_size_bytes,
        candidate.compression,
        'pending',
        candidate.expires_at
    FROM candidate
    ON CONFLICT (repository_id, bookmark_name, cache_key, cache_version)
    DO UPDATE SET
        workflow_run_id = EXCLUDED.workflow_run_id,
        object_key = EXCLUDED.object_key,
        compression = EXCLUDED.compression,
        status = 'pending',
        object_size_bytes = EXCLUDED.object_size_bytes,
        finalized_at = NULL,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
    WHERE workflow_caches.status = 'pending'
      AND (
        workflow_caches.workflow_run_id IS NULL
        OR workflow_caches.workflow_run_id = EXCLUDED.workflow_run_id
        OR workflow_caches.expires_at <= NOW()
      )
    RETURNING id
),
selected AS (
    SELECT id
    FROM upserted
    UNION ALL
    SELECT id
    FROM workflow_caches
    WHERE repository_id = sqlc.arg(repository_id)
      AND bookmark_name = sqlc.arg(bookmark_name)
      AND cache_key = sqlc.arg(cache_key)
      AND cache_version = sqlc.arg(cache_version)
      AND EXISTS (SELECT 1 FROM candidate)
      AND NOT EXISTS (SELECT 1 FROM upserted)
)
SELECT workflow_caches.*
FROM workflow_caches
JOIN selected ON selected.id = workflow_caches.id;


-- name: FinalizeWorkflowCache :one
-- The extra WHERE predicates are a compare-and-swap on the exact reservation
-- being finalized: id + status = 'pending' alone let a stale finalize from a
-- run that lost its reservation (e.g. via UpsertPendingWorkflowCache handing
-- the row to another run after expiry) claim/overwrite another run's cache
-- (issue 224). Requiring repository_id, workflow_run_id, object_key, and a
-- non-expired row makes the UPDATE a no-op (zero rows / ErrNoRows) unless the
-- caller still holds the exact reservation it originally created.
UPDATE workflow_caches
SET status = 'finalized',
    object_size_bytes = sqlc.arg(object_size_bytes),
    expires_at = sqlc.arg(expires_at),
    finalized_at = NOW(),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND status = 'pending'
  AND repository_id = sqlc.arg(repository_id)
  AND workflow_run_id = sqlc.arg(workflow_run_id)
  AND object_key = sqlc.arg(object_key)
  AND object_size_bytes = sqlc.arg(object_size_bytes)
  AND expires_at > NOW()
RETURNING *;


-- name: ClaimWorkflowCacheDeletion :one
-- Claim the exact row before touching its blob. The deleting state excludes
-- finalize and upsert while keeping metadata and declared-byte accounting
-- available if physical deletion fails and must be retried.
UPDATE workflow_caches
SET status = 'deleting',
    deletion_token = sqlc.arg(deletion_token),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND workflow_run_id IS NOT DISTINCT FROM sqlc.arg(workflow_run_id)
  AND object_key = sqlc.arg(object_key)
  AND status = sqlc.arg(expected_status)
  AND status IN ('pending', 'finalized')
RETURNING *;


-- name: RetryWorkflowCacheDeletion :one
-- A failed/crashed physical delete keeps its metadata. Acquire a fresh token
-- only when the prior caller released it or its lease is stale, preventing two
-- cleaners from acting under the same retained metadata claim.
UPDATE workflow_caches
SET deletion_token = sqlc.arg(deletion_token),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND workflow_run_id IS NOT DISTINCT FROM sqlc.arg(workflow_run_id)
  AND object_key = sqlc.arg(object_key)
  AND status = 'deleting'
  AND (
    deletion_token IS NULL
    OR updated_at <= NOW() - INTERVAL '5 minutes'
  )
RETURNING *;


-- name: ReleaseWorkflowCacheDeletionClaim :exec
UPDATE workflow_caches
SET deletion_token = NULL,
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND workflow_run_id IS NOT DISTINCT FROM sqlc.arg(workflow_run_id)
  AND object_key = sqlc.arg(object_key)
  AND status = 'deleting'
  AND deletion_token = sqlc.arg(deletion_token);


-- name: DeleteClaimedWorkflowCache :one
-- Physical deletion is complete; remove only the exact row that still holds
-- this caller's deletion claim.
DELETE FROM workflow_caches
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND workflow_run_id IS NOT DISTINCT FROM sqlc.arg(workflow_run_id)
  AND object_key = sqlc.arg(object_key)
  AND status = 'deleting'
  AND deletion_token = sqlc.arg(deletion_token)
RETURNING *;


-- name: TouchWorkflowCacheHit :exec
UPDATE workflow_caches
SET hit_count = hit_count + 1,
    last_hit_at = NOW(),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND status = 'finalized';


-- name: ListWorkflowCaches :many
SELECT *
FROM workflow_caches
WHERE repository_id = sqlc.arg(repository_id)
  AND status = 'finalized'
  AND (
    sqlc.arg(bookmark_name)::text = ''
    OR bookmark_name = sqlc.arg(bookmark_name)
  )
  AND (
    sqlc.arg(cache_key)::text = ''
    OR cache_key = sqlc.arg(cache_key)
  )
ORDER BY updated_at DESC, id DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);


-- name: ListWorkflowCachesForClear :many
SELECT *
FROM workflow_caches
WHERE repository_id = sqlc.arg(repository_id)
  AND status = 'finalized'
  AND (
    sqlc.arg(bookmark_name)::text = ''
    OR bookmark_name = sqlc.arg(bookmark_name)
  )
  AND (
    sqlc.arg(cache_key)::text = ''
    OR cache_key = sqlc.arg(cache_key)
  )
ORDER BY updated_at DESC, id DESC;


-- name: DeleteWorkflowCacheByID :one
DELETE FROM workflow_caches
WHERE id = sqlc.arg(id)
RETURNING *;


-- name: GetWorkflowCacheStats :one
SELECT
    COALESCE(COUNT(*) FILTER (WHERE status = 'finalized'), 0)::bigint AS cache_count,
    COALESCE(SUM(object_size_bytes) FILTER (WHERE status = 'finalized'), 0)::bigint AS total_size_bytes,
    MAX(last_hit_at) FILTER (WHERE status = 'finalized') AS last_hit_at,
    MAX(expires_at) FILTER (WHERE status = 'finalized') AS max_expires_at
FROM workflow_caches
WHERE repository_id = sqlc.arg(repository_id);


-- name: ListWorkflowCacheRepositoryIDs :many
SELECT DISTINCT repository_id
FROM workflow_caches
ORDER BY repository_id ASC;


-- name: ListWorkflowCacheEvictionCandidates :many
SELECT *
FROM workflow_caches
WHERE repository_id = sqlc.arg(repository_id)
  AND status IN ('pending', 'finalized', 'deleting')
ORDER BY
    CASE
        WHEN status = 'deleting' THEN 0
        WHEN expires_at <= NOW() THEN 1
        WHEN status = 'finalized' THEN 2
        ELSE 3
    END,
    COALESCE(last_hit_at, finalized_at, updated_at, created_at) ASC,
    id ASC
LIMIT sqlc.arg(limit_count);
