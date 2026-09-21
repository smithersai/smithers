-- name: CloseOrphanedRepoGatewaySandboxUsageIntervals :exec
UPDATE sandbox_usage_intervals AS usage
SET ended_at = GREATEST(usage.started_at, LEAST(now(), COALESCE(
    (SELECT COALESCE(g.deleted_at, g.last_activity_at, g.updated_at)
     FROM repo_gateways g WHERE g.id::text = usage.sandbox_id), now())))
WHERE usage.ended_at IS NULL
  AND usage.sandbox_kind = 'gateway'
  AND NOT EXISTS (
    SELECT 1 FROM repo_gateways g WHERE g.id::text = usage.sandbox_id
      AND g.status IN ('pending', 'starting', 'running') AND g.deleted_at IS NULL
  );

-- name: CountOtherActiveSandboxesForWorkspaceResume :one
-- Check the exact owned VM and all other reservations in one statement. A
-- suspended workspace no longer occupies a slot and is not excluded.
SELECT
  (
    SELECT COUNT(*) FROM workspaces w
    WHERE w.user_id = sqlc.arg(user_id)::bigint AND w.deleted_at IS NULL
      AND w.status IN ('pending', 'starting', 'running')
      AND NOT (w.id = sqlc.arg(workspace_id)::uuid AND w.vm_id = sqlc.arg(vm_id)::text AND w.status = 'running')
  ) + (
    SELECT COUNT(*) FROM repo_gateways g
    WHERE g.user_id = sqlc.arg(user_id)::bigint AND g.deleted_at IS NULL AND g.workspace_id IS NULL
      AND ((g.vm_id <> '' AND g.status IN ('starting', 'running')) OR g.status = 'pending')
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
