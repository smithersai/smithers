-- name: CreateProviderConnection :one
INSERT INTO provider_connections (
    owner_type, user_id, org_id, provider, kind, label, account_email, account_id, plan,
    access_token_encrypted, refresh_token_encrypted, access_expires_at, next_refresh_at, created_by
)
VALUES (
    sqlc.arg(owner_type), sqlc.narg(user_id), sqlc.narg(org_id), sqlc.arg(provider), sqlc.arg(kind),
    sqlc.arg(label), sqlc.arg(account_email), sqlc.arg(account_id), sqlc.arg(plan),
    sqlc.arg(access_token_encrypted), sqlc.narg(refresh_token_encrypted), sqlc.narg(access_expires_at),
    sqlc.narg(next_refresh_at), sqlc.narg(created_by)
)
RETURNING *;

-- name: GetProviderConnection :one
SELECT * FROM provider_connections WHERE id = $1;

-- name: ListUserProviderConnections :many
SELECT * FROM provider_connections
WHERE owner_type = 'user' AND user_id = $1
ORDER BY created_at DESC, id;

-- name: ListOrgProviderConnections :many
SELECT * FROM provider_connections
WHERE owner_type = 'org' AND org_id = $1
ORDER BY created_at DESC, id;

-- name: RevokeProviderConnection :execrows
UPDATE provider_connections
SET state = 'revoked', last_error = sqlc.arg(last_error), updated_at = NOW()
WHERE id = $1 AND state <> 'revoked';

-- name: UpdateProviderConnectionTokens :exec
UPDATE provider_connections
SET access_token_encrypted = sqlc.arg(access_token_encrypted),
    refresh_token_encrypted = sqlc.narg(refresh_token_encrypted),
    access_expires_at = sqlc.narg(access_expires_at),
    next_refresh_at = sqlc.narg(next_refresh_at),
    last_refresh_at = NOW(),
    refresh_failures = 0,
    last_error = '',
    state = 'active',
    updated_at = NOW()
WHERE id = $1 AND state <> 'revoked';

-- name: MarkProviderConnectionRefreshFailure :exec
UPDATE provider_connections
SET refresh_failures = sqlc.arg(refresh_failures),
    next_refresh_at = sqlc.narg(next_refresh_at),
    last_error = sqlc.arg(last_error),
    state = sqlc.arg(state),
    updated_at = NOW()
WHERE id = $1 AND state <> 'revoked';

-- name: ClaimProviderConnectionForRefresh :one
-- Leases one refreshable connection whose access token expires within the
-- horizon (or already did) by pushing next_refresh_at forward; the caller
-- refreshes outside the transaction and then records the result.
WITH due AS (
    SELECT id
    FROM provider_connections
    WHERE state = 'active'
      AND refresh_token_encrypted IS NOT NULL
      AND (access_expires_at IS NULL OR access_expires_at <= sqlc.arg(expires_before)::timestamptz)
      AND (next_refresh_at IS NULL OR next_refresh_at <= NOW())
    ORDER BY access_expires_at ASC NULLS FIRST, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
UPDATE provider_connections pc
SET next_refresh_at = sqlc.arg(lease_until)::timestamptz, updated_at = NOW()
FROM due
WHERE pc.id = due.id
RETURNING pc.*;

-- name: ResolveActiveOrgProviderConnection :one
SELECT * FROM provider_connections
WHERE owner_type = 'org' AND org_id = $1 AND provider = $2 AND state = 'active'
ORDER BY updated_at DESC, id
LIMIT 1;

-- name: ResolveActiveUserProviderConnectionForRepository :one
-- A user's connection applies to repositories the user owns, and to any other
-- repository or organization the connection was explicitly granted to.
SELECT c.* FROM provider_connections c
WHERE c.owner_type = 'user' AND c.user_id = sqlc.arg(user_id) AND c.provider = sqlc.arg(provider) AND c.state = 'active'
  AND (
      EXISTS (SELECT 1 FROM repositories r WHERE r.id = sqlc.arg(repository_id) AND r.user_id = sqlc.arg(user_id))
      OR EXISTS (
          SELECT 1 FROM provider_connection_grants g
          WHERE g.connection_id = c.id
            AND (
                g.all_repositories
                OR g.repository_id = sqlc.arg(repository_id)
                OR g.org_id = (SELECT r2.org_id FROM repositories r2 WHERE r2.id = sqlc.arg(repository_id))
            )
      )
  )
ORDER BY c.updated_at DESC, c.id
LIMIT 1;

-- name: AddProviderConnectionGrant :one
INSERT INTO provider_connection_grants (connection_id, repository_id, org_id, all_repositories)
VALUES (sqlc.arg(connection_id), sqlc.narg(repository_id), sqlc.narg(org_id), sqlc.arg(all_repositories))
RETURNING *;

-- name: ListProviderConnectionGrants :many
SELECT * FROM provider_connection_grants WHERE connection_id = $1 ORDER BY id;

-- name: DeleteProviderConnectionGrant :execrows
DELETE FROM provider_connection_grants WHERE id = $1 AND connection_id = $2;

-- name: UpsertRepositoryProviderConnectionPreference :exec
INSERT INTO repository_agent_environments (repository_id, provider_connection_preference)
VALUES (sqlc.arg(repository_id), sqlc.arg(preference))
ON CONFLICT (repository_id)
DO UPDATE SET provider_connection_preference = EXCLUDED.provider_connection_preference, updated_at = NOW();

-- name: GetRepositoryProviderConnectionPreference :one
SELECT provider_connection_preference FROM repository_agent_environments WHERE repository_id = $1;
