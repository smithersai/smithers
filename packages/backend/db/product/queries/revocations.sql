-- name: InsertRevocationEvent :one
-- Serialize allocation and commit of event IDs so a scan cannot skip a lower
-- sequence ID that commits after a higher one. The lock precedes nextval().
WITH event_lock AS MATERIALIZED (SELECT pg_advisory_xact_lock(1548769901))
INSERT INTO revocation_events (
    kind, user_id, token_id, token_hash, repository_id, organization_id,
    workspace_id, session_id, gateway_id, sandbox_ids, reason, actor_id,
    key_fingerprint
)
SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13 FROM event_lock
RETURNING *;

-- name: ListRevocationEventsAfter :many
SELECT *
FROM revocation_events
WHERE id > sqlc.arg(after_id)::bigint
ORDER BY id ASC
LIMIT sqlc.arg(limit_count)::int;

-- name: LatestRevocationEventID :one
SELECT COALESCE(MAX(id), 0)::bigint AS id FROM revocation_events;

-- name: NotifyRevocation :exec
SELECT pg_notify('revocations', sqlc.arg(payload)::text);

-- name: PruneRevocationEvents :execrows
DELETE FROM revocation_events
WHERE created_at < NOW() - make_interval(secs => sqlc.arg(max_age_seconds)::bigint);

-- name: GetAccessTokenHashByID :one
SELECT token_hash, user_id
FROM access_tokens
WHERE id = $1;
