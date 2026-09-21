-- name: CreateDeployKey :one
INSERT INTO deploy_keys (repository_id, title, key_fingerprint, public_key, read_only)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: ListDeployKeysByRepo :many
SELECT *
FROM deploy_keys
WHERE repository_id = $1
ORDER BY created_at DESC;

-- name: GetDeployKeyByID :one
SELECT *
FROM deploy_keys
WHERE id = $1;

-- name: GetDeployKeyByFingerprint :one
SELECT *
FROM deploy_keys
WHERE repository_id = $1
  AND key_fingerprint = $2;

-- name: GetAnyDeployKeyByFingerprint :one
SELECT *
FROM deploy_keys
WHERE key_fingerprint = $1
LIMIT 1;

-- name: DeleteDeployKey :exec
DELETE FROM deploy_keys
WHERE id = $1;

-- name: TouchDeployKeyLastUsed :exec
UPDATE deploy_keys
SET last_used_at = NOW()
WHERE id = $1;
