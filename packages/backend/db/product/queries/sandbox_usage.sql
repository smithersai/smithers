-- Product queries extracted from the transitional Plue source.

-- name: OpenSandboxUsageInterval :exec
INSERT INTO sandbox_usage_intervals (user_id, sandbox_kind, sandbox_id)
SELECT sqlc.arg(user_id)::bigint, sqlc.arg(sandbox_kind)::text, sqlc.arg(sandbox_id)::text
WHERE NOT EXISTS (
    SELECT 1 FROM sandbox_usage_intervals
    WHERE sandbox_kind = sqlc.arg(sandbox_kind)::text
      AND sandbox_id = sqlc.arg(sandbox_id)::text AND ended_at IS NULL
)
ON CONFLICT (sandbox_kind, sandbox_id) WHERE ended_at IS NULL DO NOTHING;


-- name: CloseSandboxUsageInterval :exec
UPDATE sandbox_usage_intervals
SET ended_at = GREATEST(started_at, now())
WHERE sandbox_kind = $1 AND sandbox_id = $2 AND ended_at IS NULL;


-- name: SumSandboxAwakeSecondsForUserSinceRaw :one
SELECT COALESCE(FLOOR(SUM(EXTRACT(EPOCH FROM
    LEAST(COALESCE(ended_at, now()), now()) - GREATEST(started_at, sqlc.arg(since)::timestamptz)
))), 0)::bigint AS seconds
FROM sandbox_usage_intervals
WHERE user_id = sqlc.arg(user_id)
  AND started_at < now()
  AND LEAST(COALESCE(ended_at, now()), now()) > GREATEST(started_at, sqlc.arg(since)::timestamptz);


-- name: CloseOrphanedSandboxUsageIntervals :exec
-- Workspace and agent intervals are product state. Private gateway adapters
-- reconcile gateway intervals against their own placement records.
UPDATE sandbox_usage_intervals AS usage
SET ended_at = GREATEST(usage.started_at, LEAST(now(), COALESCE(
    CASE usage.sandbox_kind
        WHEN 'workspace' THEN (SELECT COALESCE(w.suspended_at, w.deleted_at, w.last_activity_at, w.updated_at) FROM workspaces w WHERE w.id::text = usage.sandbox_id)
        WHEN 'agent' THEN (SELECT COALESCE(a.finished_at, a.deleted_at, a.updated_at) FROM agent_sessions a WHERE a.id::text = usage.sandbox_id)
    END, now())))
WHERE usage.ended_at IS NULL AND (
    (usage.sandbox_kind = 'workspace' AND NOT EXISTS (
        SELECT 1 FROM workspaces w WHERE w.id::text = usage.sandbox_id
        AND w.status IN ('pending', 'starting', 'running') AND w.deleted_at IS NULL
    )) OR
    (usage.sandbox_kind = 'agent' AND NOT EXISTS (
        SELECT 1 FROM agent_sessions a WHERE a.id::text = usage.sandbox_id
        AND a.status = 'active' AND a.deleted_at IS NULL
    ))
);

-- name: CountOtherActiveSandboxesForWorkspaceResume :one
-- Check the exact owned VM and all other product reservations in one statement. A
-- suspended workspace no longer occupies a slot and is not excluded.
SELECT
  (
    SELECT COUNT(*) FROM workspaces w
    WHERE w.user_id = sqlc.arg(user_id)::bigint AND w.deleted_at IS NULL
      AND w.status IN ('pending', 'starting', 'running')
      AND NOT (w.id = sqlc.arg(workspace_id)::uuid AND w.vm_id = sqlc.arg(vm_id)::text AND w.status = 'running')
  ) + (
    SELECT COUNT(*) FROM agent_sessions a
    WHERE a.user_id = sqlc.arg(user_id)::bigint AND a.status = 'active'
      AND a.started_at IS NOT NULL AND a.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE (w.id = a.workspace_id OR w.agent_session_id = a.id)
          AND w.user_id = sqlc.arg(user_id)::bigint AND w.deleted_at IS NULL
          AND w.status IN ('pending', 'starting', 'running')
      )
  ) AS others,
  EXISTS (
    SELECT 1 FROM workspaces w
    WHERE w.id = sqlc.arg(workspace_id)::uuid AND w.user_id = sqlc.arg(user_id)::bigint
      AND w.vm_id = sqlc.arg(vm_id)::text AND w.deleted_at IS NULL
      AND w.status IN ('running', 'suspended')
  ) AS matches;
