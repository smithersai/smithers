-- name: AdminListAgentSessions :many
SELECT sqlc.embed(s), u.username AS username,
       (COALESCE(ru.username, o.name, '') || '/' || r.name)::text AS repository
FROM agent_sessions s JOIN users u ON u.id = s.user_id
JOIN repositories r ON r.id = s.repository_id
LEFT JOIN users ru ON ru.id = r.user_id LEFT JOIN organizations o ON o.id = r.org_id
WHERE s.deleted_at IS NULL AND (sqlc.arg(status)::text = 'all' OR s.status = sqlc.arg(status))
AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic)
ORDER BY s.created_at DESC, s.id DESC LIMIT sqlc.arg(row_limit)::int;

-- name: AdminListWorkspaces :many
SELECT sqlc.embed(w), u.username AS owner,
       (COALESCE(ru.username, o.name, '') || '/' || r.name)::text AS repository
FROM workspaces w JOIN users u ON u.id = w.user_id
JOIN repositories r ON r.id = w.repository_id
LEFT JOIN users ru ON ru.id = r.user_id LEFT JOIN organizations o ON o.id = r.org_id
WHERE w.deleted_at IS NULL
AND (sqlc.arg(status)::text = '' OR w.status = sqlc.arg(status))
AND (sqlc.arg(kind)::text = '' OR w.kind = sqlc.arg(kind))
AND (sqlc.arg(owner)::text = '' OR u.lower_username = lower(sqlc.arg(owner)))
AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic)
ORDER BY w.created_at DESC, w.id DESC LIMIT sqlc.arg(row_limit)::int;

-- name: AdminListSandboxHosts :many
SELECT sqlc.embed(h), (SELECT count(*) FROM sandbox_instances i WHERE i.worker_id = h.id AND i.deleted_at IS NULL)::bigint AS instance_count
FROM sandbox_hosts h ORDER BY h.id;

-- name: AdminListTokens :many
SELECT t.id, t.name, u.username, t.scopes, t.last_used_at, t.expires_at, t.created_at
FROM access_tokens t JOIN users u ON u.id = t.user_id
WHERE (sqlc.arg(unused_days)::int = 0 OR COALESCE(t.last_used_at, t.created_at) < now() - make_interval(days => sqlc.arg(unused_days)::int))
AND (sqlc.arg(scope)::text = '' OR sqlc.arg(scope) = ANY(regexp_split_to_array(t.scopes, '[,[:space:]]+')))
AND (sqlc.arg(expiring_days)::int = 0 OR (t.expires_at >= now() AND t.expires_at <= now() + make_interval(days => sqlc.arg(expiring_days)::int)))
ORDER BY t.created_at DESC, t.id DESC LIMIT sqlc.arg(row_limit)::int;

-- name: AdminPruneStaleSandboxHosts :one
-- The deletion and its exact affected targets commit with the audit, or neither
-- commits. A retry cannot erase the original target list from the audit trail.
WITH pruned AS (
    DELETE FROM sandbox_hosts h
    WHERE h.lease_expires_at < now() - make_interval(hours => sqlc.arg(older_than_hours)::int)
    AND NOT EXISTS (SELECT 1 FROM sandbox_instances i WHERE i.worker_id = h.id AND i.deleted_at IS NULL)
    RETURNING h.id
), audited AS (
    INSERT INTO audit_log (event_type, actor_id, actor_name, target_type, target_name, action, metadata, ip_address)
    SELECT 'admin.sandbox_host.prune', sqlc.narg(actor_id)::bigint, sqlc.arg(actor_name)::text,
           'sandbox_host', '', 'prune',
           jsonb_build_object('outcome', 'succeeded', 'older_than_hours', sqlc.arg(older_than_hours)::int,
                              'pruned', count(*), 'host_ids', COALESCE(jsonb_agg(id ORDER BY id), '[]'::jsonb)),
           sqlc.arg(ip_address)::text
    FROM pruned
    RETURNING id
)
SELECT count(*)::bigint AS pruned FROM pruned WHERE EXISTS (SELECT 1 FROM audited);

-- name: ListNeverStartedAgentSessions :many
SELECT * FROM agent_sessions WHERE status = 'active' AND started_at IS NULL
AND deleted_at IS NULL AND created_at < sqlc.arg(cutoff)::timestamptz
ORDER BY created_at, id LIMIT 200;

-- name: FailNeverStartedAgentSession :one
UPDATE agent_sessions SET status = 'failed', finished_at = now(), updated_at = now(),
metadata = metadata || '{"failure_reason":"never_started"}'::jsonb
WHERE id = sqlc.arg(id) AND status = 'active' AND started_at IS NULL
AND deleted_at IS NULL AND created_at < sqlc.arg(cutoff)::timestamptz
RETURNING *;
