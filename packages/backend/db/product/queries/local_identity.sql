-- name: GetSelfHostOwner :one
SELECT u.*
FROM self_host_owners o
JOIN users u ON u.id = o.user_id
WHERE o.singleton = TRUE
  AND u.is_active = TRUE
  AND u.deleted_at IS NULL;

-- name: GetSelfHostLocalCredential :one
SELECT u.*, c.password_hash, c.password_changed_at
FROM self_host_owners o
JOIN users u ON u.id = o.user_id
JOIN local_credentials c ON c.user_id = u.id
WHERE o.singleton = TRUE
  AND u.is_active = TRUE
  AND u.deleted_at IS NULL;

-- name: BootstrapSelfHostOwner :one
WITH created_user AS (
    INSERT INTO users (
        username,
        lower_username,
        email,
        lower_email,
        display_name,
        is_admin
    )
    SELECT
        sqlc.arg(username),
        sqlc.arg(lower_username),
        sqlc.arg(email),
        sqlc.arg(lower_email),
        sqlc.arg(display_name),
        TRUE
    WHERE NOT EXISTS (SELECT 1 FROM self_host_owners)
    RETURNING *
), claimed AS (
    INSERT INTO self_host_owners (singleton, user_id)
    SELECT TRUE, id FROM created_user
    RETURNING user_id
), credential AS (
    INSERT INTO local_credentials (user_id, password_hash)
    SELECT user_id, sqlc.arg(password_hash) FROM claimed
    RETURNING user_id
)
SELECT created_user.*
FROM created_user
JOIN credential ON credential.user_id = created_user.id;

-- name: UpdateSelfHostOwnerPassword :execrows
UPDATE local_credentials c
SET password_hash = sqlc.arg(password_hash),
    password_changed_at = NOW(),
    updated_at = NOW()
FROM self_host_owners o
WHERE o.singleton = TRUE
  AND o.user_id = sqlc.arg(user_id)
  AND c.user_id = o.user_id;
