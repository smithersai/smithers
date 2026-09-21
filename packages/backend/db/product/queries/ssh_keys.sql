-- name: GetUserBySSHFingerprint :one
SELECT u.id AS user_id, u.username FROM ssh_keys k
JOIN users u ON k.user_id = u.id
WHERE k.fingerprint = $1 AND u.is_active = true AND u.prohibit_login = false;

-- name: ListUserSSHKeys :many
SELECT *
FROM ssh_keys
WHERE user_id = $1
ORDER BY created_at DESC;

-- name: CreateSSHKey :one
INSERT INTO ssh_keys (user_id, name, public_key, fingerprint, key_type)
VALUES (
    sqlc.arg(user_id),
    sqlc.arg(name),
    sqlc.arg(public_key),
    sqlc.arg(fingerprint),
    sqlc.arg(key_type)
)
RETURNING *;

-- name: DeleteSSHKey :exec
DELETE FROM ssh_keys
WHERE id = sqlc.arg(id)
  AND user_id = sqlc.arg(user_id);

-- name: GetSSHKeyByID :one
SELECT *
FROM ssh_keys
WHERE id = $1;

-- name: GetSSHKeyByFingerprint :one
SELECT *
FROM ssh_keys
WHERE fingerprint = $1;
