-- name: CreateJjOperation :one
INSERT INTO jj_operations (
    repository_id,
    operation_id,
    operation_type,
    description,
    user_id,
    parent_operation_id,
    workspace_id,
    change_ids
)
VALUES (
    $1, $2, $3, $4, $5, $6,
    NULLIF(sqlc.arg(workspace_id)::text, '')::uuid,
    COALESCE(sqlc.arg(change_ids)::text[], '{}'::text[])
)
RETURNING *;

-- name: RecordWorkspaceCodingOperation :one
-- Projection of a native JJ receipt, not an execution ledger. Identical retry
-- is safe; a different actor/workspace/operation may never claim the same ID.
INSERT INTO jj_operations (
    repository_id, operation_id, operation_type, description, user_id,
    parent_operation_id, workspace_id, change_ids, created_at
)
VALUES ($1, $2, $3, $4, $5, $6, sqlc.arg(workspace_id)::uuid,
        sqlc.arg(change_ids)::text[], sqlc.arg(created_at)::timestamptz)
ON CONFLICT (repository_id, operation_id) DO UPDATE
SET operation_id = jj_operations.operation_id
WHERE jj_operations.user_id = EXCLUDED.user_id
  AND jj_operations.workspace_id = EXCLUDED.workspace_id
  AND jj_operations.parent_operation_id = EXCLUDED.parent_operation_id
  AND jj_operations.operation_type = EXCLUDED.operation_type
  AND jj_operations.change_ids = EXCLUDED.change_ids
RETURNING *;

-- name: GetJjOperationByOperationID :one
SELECT *
FROM jj_operations
WHERE repository_id = $1
  AND operation_id = $2;

-- name: CountJjOperationsByRepo :one
SELECT COUNT(*)
FROM jj_operations
WHERE repository_id = $1;

-- name: ListJjOperationsByRepo :many
SELECT *
FROM jj_operations
WHERE repository_id = $1
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: ListJjOperationsForChange :many
SELECT operation.*
FROM jj_operations AS operation
WHERE operation.repository_id = sqlc.arg(repository_id)
  AND (
      sqlc.narg(revision_seq)::bigint IS NULL
      AND sqlc.arg(change_id)::text = ANY(operation.change_ids)
      OR EXISTS (
          SELECT 1
          FROM change_revisions AS revision
          WHERE revision.repository_id = operation.repository_id
            AND revision.change_id = sqlc.arg(change_id)
            AND (sqlc.narg(revision_seq)::bigint IS NULL OR revision.seq = sqlc.narg(revision_seq)::bigint)
            AND operation.operation_id = ANY(revision.operation_ids)
      )
  )
ORDER BY operation.created_at DESC, operation.id DESC;

-- name: GetJjOperationForWorkspace :one
SELECT *
FROM jj_operations
WHERE repository_id = sqlc.arg(repository_id)
  AND operation_id = sqlc.arg(operation_id)
  AND workspace_id = NULLIF(sqlc.arg(workspace_id)::text, '')::uuid;

-- name: CountLaterJjOperationsInWorkspace :one
SELECT COUNT(*)
FROM jj_operations AS later
WHERE later.repository_id = sqlc.arg(repository_id)
  AND later.workspace_id = sqlc.arg(workspace_id)::uuid
  AND (
      later.created_at > sqlc.arg(created_at)
      OR (later.created_at = sqlc.arg(created_at) AND later.id > sqlc.arg(id))
  );
