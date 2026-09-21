-- name: CreateWorkflowArtifact :one
WITH next_artifact AS (
    SELECT nextval(pg_get_serial_sequence('workflow_artifacts', 'id')) AS id
)
INSERT INTO workflow_artifacts (
    id,
    repository_id,
    workflow_run_id,
    name,
    size,
    content_type,
    status,
    gcs_key,
    expires_at
)
SELECT
    next_artifact.id,
    args.repository_id,
    args.workflow_run_id,
    args.name,
    args.size,
    args.content_type,
    'pending',
    'repos/' || args.repository_id::text || '/runs/' ||
    args.workflow_run_id::text || '/artifacts/' ||
    next_artifact.id::text || '/' || args.name,
    args.expires_at
FROM next_artifact
CROSS JOIN (
    VALUES (
        sqlc.arg(repository_id)::bigint,
        sqlc.arg(workflow_run_id)::bigint,
        sqlc.arg(name)::text,
        sqlc.arg(size)::bigint,
        sqlc.arg(content_type)::text,
        sqlc.arg(expires_at)::timestamptz
    )
) AS args(repository_id, workflow_run_id, name, size, content_type, expires_at)
WHERE EXISTS (
    SELECT 1
    FROM workflow_runs AS wr
    WHERE wr.id = args.workflow_run_id
      AND wr.repository_id = args.repository_id
)
RETURNING
    id,
    repository_id,
    workflow_run_id,
    name,
    size,
    content_type,
    status,
    gcs_key,
    confirmed_at,
    deletion_token,
    expires_at,
    release_tag,
    release_asset_name,
    release_attached_at,
    created_at,
    updated_at;

-- name: ConfirmWorkflowArtifactUpload :one
-- Every predicate is part of the reservation identity captured before blob
-- validation. A same-name replacement receives a new id/object key; a stale
-- confirmer must never mark that unvalidated replacement ready or meter the
-- old row's size for it.
UPDATE workflow_artifacts
SET status = 'ready',
    confirmed_at = NOW(),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND workflow_run_id = sqlc.arg(workflow_run_id)
  AND name = sqlc.arg(name)
  AND gcs_key = sqlc.arg(gcs_key)
  AND status = 'pending'
  AND deletion_token IS NULL
RETURNING
    id,
    repository_id,
    workflow_run_id,
    name,
    size,
    content_type,
    status,
    gcs_key,
    confirmed_at,
    deletion_token,
    expires_at,
    release_tag,
    release_asset_name,
    release_attached_at,
    created_at,
    updated_at;

-- name: GetWorkflowDefinitionNameByRunID :one
SELECT wd.name
FROM workflow_runs AS wr
JOIN workflow_definitions AS wd ON wd.id = wr.workflow_definition_id
WHERE wr.id = $1;

-- name: ListWorkflowArtifactsByRun :many
SELECT
    id,
    repository_id,
    workflow_run_id,
    name,
    size,
    content_type,
    status,
    gcs_key,
    confirmed_at,
    deletion_token,
    expires_at,
    release_tag,
    release_asset_name,
    release_attached_at,
    created_at,
    updated_at
FROM workflow_artifacts
WHERE workflow_run_id = $1
ORDER BY created_at DESC, id DESC;

-- name: GetWorkflowArtifactByName :one
SELECT
    id,
    repository_id,
    workflow_run_id,
    name,
    size,
    content_type,
    status,
    gcs_key,
    confirmed_at,
    deletion_token,
    expires_at,
    release_tag,
    release_asset_name,
    release_attached_at,
    created_at,
    updated_at
FROM workflow_artifacts
WHERE workflow_run_id = sqlc.arg(workflow_run_id)
  AND name = sqlc.arg(name);

-- name: DeleteWorkflowArtifact :exec
-- Deprecated compatibility query. Production artifact services must use the
-- claim/token deletion protocol below so physical cleanup is retryable.
DELETE FROM workflow_artifacts
WHERE workflow_run_id = sqlc.arg(workflow_run_id)
  AND name = sqlc.arg(name);

-- name: DeleteWorkflowArtifactByID :exec
-- Deprecated compatibility query. Production artifact services must use the
-- claim/token deletion protocol below so physical cleanup is retryable.
DELETE FROM workflow_artifacts
WHERE id = sqlc.arg(id);

-- name: ClaimWorkflowArtifactDeletion :one
-- Claim the exact reservation before physical deletion. Confirm and
-- same-name replacement both exclude deleting rows, while retained metadata
-- keeps the declared bytes in quota accounting after a blob failure.
UPDATE workflow_artifacts
SET status = 'deleting',
    deletion_token = sqlc.arg(deletion_token),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND workflow_run_id = sqlc.arg(workflow_run_id)
  AND name = sqlc.arg(name)
  AND gcs_key = sqlc.arg(gcs_key)
  AND status = sqlc.arg(expected_status)
  AND status IN ('pending', 'ready')
  AND deletion_token IS NULL
RETURNING *;

-- name: RetryWorkflowArtifactDeletion :one
UPDATE workflow_artifacts
SET deletion_token = sqlc.arg(deletion_token),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND workflow_run_id = sqlc.arg(workflow_run_id)
  AND name = sqlc.arg(name)
  AND gcs_key = sqlc.arg(gcs_key)
  AND status = 'deleting'
  AND (
    deletion_token IS NULL
    OR updated_at <= sqlc.arg(stale_before)
  )
RETURNING *;

-- name: ReleaseWorkflowArtifactDeletionClaim :exec
UPDATE workflow_artifacts
SET deletion_token = NULL,
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND workflow_run_id = sqlc.arg(workflow_run_id)
  AND name = sqlc.arg(name)
  AND gcs_key = sqlc.arg(gcs_key)
  AND status = 'deleting'
  AND deletion_token = sqlc.arg(deletion_token);

-- name: DeleteClaimedWorkflowArtifact :one
DELETE FROM workflow_artifacts
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND workflow_run_id = sqlc.arg(workflow_run_id)
  AND name = sqlc.arg(name)
  AND gcs_key = sqlc.arg(gcs_key)
  AND status = 'deleting'
  AND deletion_token = sqlc.arg(deletion_token)
RETURNING *;

-- name: ListPrunableWorkflowArtifacts :many
-- Pending capability expiry is independent of artifact retention: pending
-- rows become reclaimable shortly after their signed URL expires, while ready
-- rows follow expires_at. Released/stale deleting claims are retry candidates.
SELECT
    id,
    repository_id,
    workflow_run_id,
    name,
    size,
    content_type,
    status,
    gcs_key,
    confirmed_at,
    deletion_token,
    expires_at,
    release_tag,
    release_asset_name,
    release_attached_at,
    created_at,
    updated_at
FROM workflow_artifacts
WHERE (
        status = 'pending'
        AND created_at <= sqlc.arg(pending_created_before)
    )
    OR (
        status = 'ready'
        AND expires_at <= sqlc.arg(ready_expires_before)
    )
    OR (
        status = 'deleting'
        -- Released claims cool down too. Otherwise permanently failing rows
        -- are immediately selected again and can monopolize every batch.
        AND updated_at <= sqlc.arg(deletion_stale_before)
    )
ORDER BY
    CASE
        WHEN status = 'deleting' THEN updated_at
        WHEN status = 'ready' THEN expires_at
        ELSE created_at
    END ASC,
    id ASC
LIMIT sqlc.arg(limit_rows);

-- name: PruneExpiredWorkflowArtifacts :many
-- Deprecated compatibility query. Production cleanup must use
-- ListPrunableWorkflowArtifacts followed by the claim/token deletion protocol.
DELETE FROM workflow_artifacts
WHERE id IN (
    SELECT wa.id
    FROM workflow_artifacts AS wa
    WHERE wa.expires_at <= sqlc.arg(expires_before)
    ORDER BY wa.expires_at ASC, wa.id ASC
    LIMIT sqlc.arg(limit_rows)
)
RETURNING
    id,
    repository_id,
    workflow_run_id,
    name,
    size,
    content_type,
    status,
    gcs_key,
    confirmed_at,
    deletion_token,
    expires_at,
    release_tag,
    release_asset_name,
    release_attached_at,
    created_at,
    updated_at;

-- name: AttachWorkflowArtifactToRelease :one
UPDATE workflow_artifacts
SET release_tag = sqlc.arg(release_tag),
    release_asset_name = sqlc.arg(release_asset_name),
    release_attached_at = NOW(),
    updated_at = NOW()
WHERE workflow_run_id = sqlc.arg(workflow_run_id)
  AND name = sqlc.arg(name)
  AND status = 'ready'
  AND deletion_token IS NULL
RETURNING
    id,
    repository_id,
    workflow_run_id,
    name,
    size,
    content_type,
    status,
    gcs_key,
    confirmed_at,
    deletion_token,
    expires_at,
    release_tag,
    release_asset_name,
    release_attached_at,
    created_at,
    updated_at;
