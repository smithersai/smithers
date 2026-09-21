-- ---- Sandbox Access Tokens (SSH/Terminal gateway auth) ----

-- name: CreateSandboxAccessToken :one
INSERT INTO sandbox_access_tokens (
    workspace_id,
    vm_id,
    user_id,
    linux_user,
    token_hash,
    token_type,
    expires_at
)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: GetSandboxAccessTokenByHash :one
SELECT *
FROM sandbox_access_tokens
WHERE token_hash = $1
  AND used_at IS NULL
  AND expires_at > NOW();

-- name: MarkSandboxAccessTokenUsed :exec
UPDATE sandbox_access_tokens
SET used_at = NOW()
WHERE id = $1
  AND used_at IS NULL;

-- name: DeleteExpiredSandboxAccessTokens :exec
DELETE FROM sandbox_access_tokens
WHERE expires_at < NOW();
