-- name: CreateOAuth2Application :one
INSERT INTO oauth2_applications (
    client_id,
    client_secret_hash,
    name,
    redirect_uris,
    scopes,
    owner_id,
    confidential
)
VALUES (
    sqlc.arg(client_id),
    sqlc.arg(client_secret_hash),
    sqlc.arg(name),
    sqlc.arg(redirect_uris),
    sqlc.arg(scopes),
    sqlc.arg(owner_id),
    sqlc.arg(confidential)
)
RETURNING *;

-- name: GetOAuth2ApplicationByID :one
SELECT *
FROM oauth2_applications
WHERE id = $1;

-- name: GetOAuth2ApplicationByClientID :one
SELECT *
FROM oauth2_applications
WHERE client_id = $1;

-- name: ListOAuth2ApplicationsByOwner :many
SELECT *
FROM oauth2_applications
WHERE owner_id = $1
ORDER BY created_at DESC;

-- name: UpdateOAuth2Application :one
UPDATE oauth2_applications
SET name = sqlc.arg(name),
    redirect_uris = sqlc.arg(redirect_uris),
    scopes = sqlc.arg(scopes),
    confidential = sqlc.arg(confidential),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND owner_id = sqlc.arg(owner_id)
RETURNING *;

-- name: DeleteOAuth2Application :execrows
DELETE FROM oauth2_applications
WHERE id = sqlc.arg(id)
  AND owner_id = sqlc.arg(owner_id);

-- name: CreateOAuth2AuthorizationCode :exec
INSERT INTO oauth2_authorization_codes (
    code_hash,
    app_id,
    user_id,
    scopes,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    expires_at
)
VALUES (
    sqlc.arg(code_hash),
    sqlc.arg(app_id),
    sqlc.arg(user_id),
    sqlc.arg(scopes),
    sqlc.arg(redirect_uri),
    sqlc.arg(code_challenge),
    sqlc.arg(code_challenge_method),
    sqlc.arg(expires_at)
);

-- name: ConsumeOAuth2AuthorizationCode :one
UPDATE oauth2_authorization_codes
SET used_at = NOW()
WHERE code_hash = sqlc.arg(code_hash)
  AND used_at IS NULL
  AND expires_at > NOW()
RETURNING *;

-- name: DeleteExpiredOAuth2AuthorizationCodes :exec
DELETE FROM oauth2_authorization_codes
WHERE expires_at < NOW();

-- name: CreateOAuth2AccessToken :one
INSERT INTO oauth2_access_tokens (
    token_hash,
    app_id,
    user_id,
    scopes,
    expires_at
)
VALUES (
    sqlc.arg(token_hash),
    sqlc.arg(app_id),
    sqlc.arg(user_id),
    sqlc.arg(scopes),
    sqlc.arg(expires_at)
)
RETURNING *;

-- name: GetOAuth2AccessTokenByHash :one
SELECT *
FROM oauth2_access_tokens
WHERE token_hash = $1
  AND expires_at > NOW();

-- name: DeleteOAuth2AccessTokensByAppAndUser :exec
DELETE FROM oauth2_access_tokens
WHERE app_id = sqlc.arg(app_id)
  AND user_id = sqlc.arg(user_id);

-- name: DeleteOAuth2AccessTokenByHash :execrows
DELETE FROM oauth2_access_tokens
WHERE token_hash = $1;

-- name: DeleteExpiredOAuth2AccessTokens :many
DELETE FROM oauth2_access_tokens
WHERE expires_at < NOW()
RETURNING *;

-- name: CreateOAuth2RefreshToken :one
INSERT INTO oauth2_refresh_tokens (
    token_hash,
    app_id,
    user_id,
    scopes,
    expires_at
)
VALUES (
    sqlc.arg(token_hash),
    sqlc.arg(app_id),
    sqlc.arg(user_id),
    sqlc.arg(scopes),
    sqlc.arg(expires_at)
)
RETURNING *;

-- name: GetOAuth2RefreshTokenByHash :one
SELECT *
FROM oauth2_refresh_tokens
WHERE token_hash = $1
  AND expires_at > NOW();

-- name: ConsumeOAuth2RefreshToken :one
DELETE FROM oauth2_refresh_tokens
WHERE token_hash = $1
  AND expires_at > NOW()
RETURNING *;

-- name: DeleteOAuth2RefreshTokenByHash :execrows
DELETE FROM oauth2_refresh_tokens
WHERE token_hash = $1;

-- name: DeleteOAuth2RefreshTokensByAppAndUser :exec
DELETE FROM oauth2_refresh_tokens
WHERE app_id = sqlc.arg(app_id)
  AND user_id = sqlc.arg(user_id);

-- name: DeleteExpiredOAuth2RefreshTokens :exec
DELETE FROM oauth2_refresh_tokens
WHERE expires_at < NOW();

-- name: ListOAuth2AccessTokensByUser :many
SELECT t.*, a.name AS app_name, a.client_id AS app_client_id
FROM oauth2_access_tokens t
JOIN oauth2_applications a ON a.id = t.app_id
WHERE t.user_id = $1
  AND t.expires_at > NOW()
ORDER BY t.created_at DESC;
