-- name: CreateLinearOAuthSetup :one
INSERT INTO linear_oauth_setups (setup_key, user_id, payload_encrypted, expires_at)
VALUES (sqlc.arg(setup_key), sqlc.arg(user_id), sqlc.arg(payload_encrypted), sqlc.arg(expires_at))
RETURNING *;

-- name: DeleteLinearOAuthSetupsByUser :exec
DELETE FROM linear_oauth_setups
WHERE user_id = sqlc.arg(user_id)
  AND used_at IS NULL;

-- name: GetLinearOAuthSetupByUser :one
SELECT *
FROM linear_oauth_setups
WHERE setup_key = sqlc.arg(setup_key)
  AND user_id = sqlc.arg(user_id)
  AND used_at IS NULL
  AND expires_at > NOW();

-- name: ConsumeLinearOAuthSetupByUser :one
WITH consumed AS (
    DELETE FROM linear_oauth_setups
    WHERE setup_key = sqlc.arg(setup_key)
      AND user_id = sqlc.arg(user_id)
      AND used_at IS NULL
      AND expires_at > NOW()
    RETURNING *
)
SELECT *
FROM consumed
;

-- name: DeleteExpiredLinearOAuthSetups :exec
DELETE FROM linear_oauth_setups
WHERE expires_at < NOW();
