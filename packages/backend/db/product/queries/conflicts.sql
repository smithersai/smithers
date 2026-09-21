-- name: UpsertConflict :one
INSERT INTO conflicts (repository_id, change_id, file_path, conflict_type)
VALUES ($1, $2, $3, $4)
ON CONFLICT (repository_id, change_id, file_path)
DO UPDATE SET
    conflict_type = EXCLUDED.conflict_type,
    resolved = FALSE,
    resolved_by = NULL,
    resolution_method = '',
    resolved_at = NULL,
    updated_at = NOW()
RETURNING *;

-- name: MarkConflictResolved :execrows
UPDATE conflicts
SET resolved = TRUE,
    resolved_by = $4,
    resolution_method = $5,
    resolved_at = NOW(),
    updated_at = NOW()
WHERE repository_id = $1
  AND change_id = $2
  AND file_path = $3;

-- name: ListConflictsByChangeID :many
SELECT *
FROM conflicts
WHERE repository_id = $1
  AND change_id = $2
ORDER BY file_path ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: GetConflictByPath :one
SELECT *
FROM conflicts
WHERE repository_id = $1
  AND change_id = $2
  AND file_path = $3;

-- name: DeleteConflictsByChangeID :execrows
DELETE FROM conflicts
WHERE repository_id = $1
  AND change_id = $2;
