-- name: CreateMilestone :one
INSERT INTO milestones (repository_id, title, description, due_date)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: ListMilestonesByRepo :many
SELECT *
FROM milestones
WHERE repository_id = sqlc.arg(repository_id)
  AND (sqlc.arg(state)::text = '' OR state = sqlc.arg(state)::text)
ORDER BY id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CountMilestonesByRepo :one
SELECT COUNT(*)
FROM milestones
WHERE repository_id = sqlc.arg(repository_id)
  AND (sqlc.arg(state)::text = '' OR state = sqlc.arg(state)::text);

-- name: GetMilestoneByID :one
SELECT *
FROM milestones
WHERE repository_id = $1
  AND id = $2;

-- name: UpdateMilestone :one
UPDATE milestones
SET title = $3,
    description = $4,
    state = $5,
    due_date = $6,
    closed_at = $7,
    updated_at = NOW()
WHERE repository_id = $1
  AND id = $2
RETURNING *;

-- name: DeleteMilestone :exec
WITH repository_lock AS MATERIALIZED (SELECT repositories.id FROM repositories WHERE repositories.id = sqlc.arg(repository_id) FOR UPDATE)
DELETE FROM milestones USING repository_lock
WHERE repository_id = repository_lock.id AND milestones.id = sqlc.arg(id);
