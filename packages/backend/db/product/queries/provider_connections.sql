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
ORDER BY provider, sort_order, created_at, id;

-- name: ListOrgProviderConnections :many
SELECT * FROM provider_connections
WHERE owner_type = 'org' AND org_id = $1
ORDER BY provider, sort_order, created_at, id;

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
    refresh_lease_until = NULL,
    refresh_failures = 0,
    last_error = '',
    state = 'active',
    updated_at = NOW()
WHERE id = $1 AND state <> 'revoked' AND refresh_generation = sqlc.arg(refresh_generation);

-- name: MarkProviderConnectionRefreshFailure :exec
UPDATE provider_connections
SET refresh_lease_until = NULL,
    refresh_failures = sqlc.arg(refresh_failures),
    next_refresh_at = sqlc.narg(next_refresh_at),
    last_error = sqlc.arg(last_error),
    state = sqlc.arg(state),
    updated_at = NOW()
WHERE id = $1 AND state <> 'revoked' AND refresh_generation = sqlc.arg(refresh_generation);

-- name: ClaimProviderConnectionForRefresh :one
-- Leases one refreshable connection whose access token expires within the
-- horizon (or already did), or a specific interactive connection; the caller
-- refreshes outside the transaction and then records the result.
WITH due AS (
    SELECT id
    FROM provider_connections
    WHERE (state = 'active' OR (sqlc.arg(connection_id)::text <> '' AND state = 'refresh_failed'))
      AND (sqlc.arg(connection_id)::text = '' OR id::text = sqlc.arg(connection_id)::text)
      AND (refresh_lease_until IS NULL OR refresh_lease_until <= NOW())
      AND refresh_token_encrypted IS NOT NULL
      AND (sqlc.arg(connection_id)::text <> '' OR access_expires_at IS NULL OR access_expires_at <= sqlc.arg(expires_before)::timestamptz)
      AND (sqlc.arg(connection_id)::text <> '' OR next_refresh_at IS NULL OR next_refresh_at <= NOW())
    ORDER BY access_expires_at ASC NULLS FIRST, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
UPDATE provider_connections pc
SET refresh_lease_until = sqlc.arg(lease_until)::timestamptz,
    refresh_generation = pc.refresh_generation + 1, updated_at = NOW()
FROM due
WHERE pc.id = due.id
RETURNING pc.*;

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

-- name: ProviderConnectionPoolStatus :one
-- The pool one source offers a run: the org's connections, or the user's
-- connections that apply to the repository (owned, or granted). Revoked rows
-- are not part of any pool.
SELECT
    count(*) FILTER (WHERE c.state = 'active')::bigint AS active,
    count(*) FILTER (WHERE c.state = 'active' AND (c.limited_until IS NULL OR c.limited_until <= clock_timestamp()))::bigint AS usable,
    count(*) FILTER (WHERE c.state = 'refresh_failed')::bigint AS reconnect,
    COALESCE(min(c.limited_until) FILTER (WHERE c.state = 'active' AND c.limited_until > clock_timestamp()), 'epoch'::timestamptz)::timestamptz AS next_reset
FROM provider_connections c
WHERE c.provider = sqlc.arg(provider) AND c.state <> 'revoked'
  AND (
      (sqlc.arg(source)::text = 'org' AND c.owner_type = 'org' AND c.org_id = sqlc.arg(org_id)::bigint)
      OR (
          sqlc.arg(source)::text = 'user' AND c.owner_type = 'user' AND c.user_id = sqlc.arg(user_id)::bigint
          AND (
              EXISTS (SELECT 1 FROM repositories r WHERE r.id = sqlc.arg(repository_id)::bigint AND r.user_id = sqlc.arg(user_id)::bigint)
              OR EXISTS (
                  SELECT 1 FROM provider_connection_grants g
                  WHERE g.connection_id = c.id
                    AND (g.all_repositories OR g.repository_id = sqlc.arg(repository_id)::bigint
                         OR g.org_id = (SELECT r2.org_id FROM repositories r2 WHERE r2.id = sqlc.arg(repository_id)::bigint))
              )
          )
      )
  );

-- name: PickProviderConnection :one
-- Round-robin: the least recently used usable connection of the pool (ties
-- by sort_order), stamped as used in the same statement. SKIP LOCKED keeps
-- two concurrent picks off the same row; the lock ends with the statement,
-- so this is fair rotation, not an exclusive reservation.
WITH candidate AS (
    SELECT c.id FROM provider_connections c
    WHERE c.provider = sqlc.arg(provider) AND c.state = 'active'
      AND (c.limited_until IS NULL OR c.limited_until <= clock_timestamp())
      AND NOT (c.id = ANY(sqlc.arg(excluded)::uuid[]))
      AND (
          (sqlc.arg(source)::text = 'org' AND c.owner_type = 'org' AND c.org_id = sqlc.arg(org_id)::bigint)
          OR (
              sqlc.arg(source)::text = 'user' AND c.owner_type = 'user' AND c.user_id = sqlc.arg(user_id)::bigint
              AND (
                  EXISTS (SELECT 1 FROM repositories r WHERE r.id = sqlc.arg(repository_id)::bigint AND r.user_id = sqlc.arg(user_id)::bigint)
                  OR EXISTS (
                      SELECT 1 FROM provider_connection_grants g
                      WHERE g.connection_id = c.id
                        AND (g.all_repositories OR g.repository_id = sqlc.arg(repository_id)::bigint
                             OR g.org_id = (SELECT r2.org_id FROM repositories r2 WHERE r2.id = sqlc.arg(repository_id)::bigint))
                  )
              )
          )
      )
    ORDER BY c.last_used_at ASC NULLS FIRST, c.sort_order, c.created_at, c.id
    FOR UPDATE OF c SKIP LOCKED
    LIMIT 1
)
UPDATE provider_connections pc
SET last_used_at = clock_timestamp()
FROM candidate
WHERE pc.id = candidate.id
RETURNING pc.*;

-- name: PickProviderConnectionWaiting :one
-- PickProviderConnection when every usable row was locked by a concurrent
-- pick: wait for one instead of reporting an empty pool.
WITH candidate AS (
    SELECT c.id FROM provider_connections c
    WHERE c.provider = sqlc.arg(provider) AND c.state = 'active'
      AND (c.limited_until IS NULL OR c.limited_until <= clock_timestamp())
      AND NOT (c.id = ANY(sqlc.arg(excluded)::uuid[]))
      AND (
          (sqlc.arg(source)::text = 'org' AND c.owner_type = 'org' AND c.org_id = sqlc.arg(org_id)::bigint)
          OR (
              sqlc.arg(source)::text = 'user' AND c.owner_type = 'user' AND c.user_id = sqlc.arg(user_id)::bigint
              AND (
                  EXISTS (SELECT 1 FROM repositories r WHERE r.id = sqlc.arg(repository_id)::bigint AND r.user_id = sqlc.arg(user_id)::bigint)
                  OR EXISTS (
                      SELECT 1 FROM provider_connection_grants g
                      WHERE g.connection_id = c.id
                        AND (g.all_repositories OR g.repository_id = sqlc.arg(repository_id)::bigint
                             OR g.org_id = (SELECT r2.org_id FROM repositories r2 WHERE r2.id = sqlc.arg(repository_id)::bigint))
                  )
              )
          )
      )
    ORDER BY c.last_used_at ASC NULLS FIRST, c.sort_order, c.created_at, c.id
    FOR UPDATE OF c
    LIMIT 1
)
UPDATE provider_connections pc
SET last_used_at = clock_timestamp()
FROM candidate
WHERE pc.id = candidate.id
RETURNING pc.*;

-- name: MarkProviderConnectionLimited :exec
-- A usage limit only ever extends: a shorter, older reset cannot shorten it.
UPDATE provider_connections
SET limited_until = GREATEST(COALESCE(limited_until, sqlc.arg(limited_until)::timestamptz), sqlc.arg(limited_until)::timestamptz),
    updated_at = NOW()
WHERE id = sqlc.arg(id) AND state <> 'revoked';

-- name: MarkProviderConnectionRejected :execrows
-- The provider refused the credential itself. Fenced by the refresh
-- generation the request used, so a refresh that already replaced the token
-- is not undone by a late refusal of the old one.
UPDATE provider_connections
SET state = 'refresh_failed', last_error = sqlc.arg(last_error), updated_at = NOW()
WHERE id = sqlc.arg(id) AND state = 'active' AND refresh_generation = sqlc.arg(refresh_generation);

-- name: SetUserProviderConnectionSortOrder :execrows
-- Reordering restarts the rotation at the top of the new order.
UPDATE provider_connections
SET sort_order = sqlc.arg(sort_order), last_used_at = NULL, updated_at = NOW()
WHERE id = sqlc.arg(id) AND owner_type = 'user' AND user_id = sqlc.arg(user_id) AND provider = sqlc.arg(provider);

-- name: RevokeOtherUserProviderAccountConnections :execrows
-- Reconnecting the same provider account replaces its OLDER connections only,
-- so two concurrent sign-ins of one account never revoke each other.
UPDATE provider_connections old
SET state = 'revoked', last_error = 'replaced by a newer sign-in', updated_at = NOW()
FROM provider_connections keep
WHERE keep.id = sqlc.arg(keep_id)
  AND old.owner_type = 'user' AND old.user_id = sqlc.arg(user_id) AND old.provider = sqlc.arg(provider)
  AND old.account_id = sqlc.arg(account_id) AND old.account_id <> '' AND old.state <> 'revoked'
  AND (old.created_at, old.id) < (keep.created_at, keep.id);

-- name: CreateProviderConnectionDeviceLogin :one
INSERT INTO provider_connection_device_logins (user_id, provider, device_auth_id_encrypted, user_code, interval_seconds, expires_at, next_poll_at)
VALUES (sqlc.arg(user_id), sqlc.arg(provider), sqlc.arg(device_auth_id_encrypted), sqlc.arg(user_code), sqlc.arg(interval_seconds), sqlc.arg(expires_at), sqlc.arg(next_poll_at))
RETURNING *;

-- name: GetProviderConnectionDeviceLogin :one
SELECT * FROM provider_connection_device_logins WHERE id = sqlc.arg(id) AND user_id = sqlc.arg(user_id);

-- name: ClaimProviderConnectionDeviceLoginPoll :one
-- One poller at a time, never sooner than the provider's interval.
UPDATE provider_connection_device_logins
SET poll_lease_until = sqlc.arg(lease_until)::timestamptz, updated_at = NOW()
WHERE id = sqlc.arg(id) AND user_id = sqlc.arg(user_id) AND state = 'pending'
  AND next_poll_at <= NOW()
  AND (poll_lease_until IS NULL OR poll_lease_until <= NOW())
RETURNING *;

-- name: FinishProviderConnectionDeviceLoginPoll :execrows
-- Only the poller holding the lease finishes a poll, except that a stored
-- connection always records itself, even after its lease lapsed.
UPDATE provider_connection_device_logins
SET poll_lease_until = NULL, next_poll_at = sqlc.arg(next_poll_at), state = sqlc.arg(state),
    connection_id = sqlc.narg(connection_id), last_error = sqlc.arg(last_error), updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND (
      (state = 'pending' AND poll_lease_until = sqlc.arg(lease_until)::timestamptz)
      OR (sqlc.arg(state)::text = 'connected' AND state IN ('pending', 'expired'))
  );

-- name: ExpireProviderConnectionDeviceLogin :execrows
-- A sign-in past its deadline expires unless a poll holds it (that poll may
-- be completing the exchange and finishes it itself).
UPDATE provider_connection_device_logins
SET state = 'expired', updated_at = NOW()
WHERE id = sqlc.arg(id) AND user_id = sqlc.arg(user_id) AND state = 'pending' AND expires_at <= NOW()
  AND (poll_lease_until IS NULL OR poll_lease_until <= NOW());
