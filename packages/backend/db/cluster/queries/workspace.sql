-- Private cluster queries kept separate from the product graph.

-- name: ListIdleWorkspaces :many
-- Finds workspaces with status=running whose last_activity_at > idle_timeout_secs ago.
-- Excludes workspaces that still have a LIVE (non-idle) running session: terminal
-- WebSocket traffic bumps only the session's last_activity_at (not the
-- workspace's), so without this exclusion the idle sweeper would suspend a VM out
-- from under an actively-used terminal.
SELECT w.*
FROM workspaces w
WHERE w.status = 'running'
  AND w.deleted_at IS NULL
  AND w.idle_timeout_secs > 0
  AND NOW() > w.last_activity_at + make_interval(secs => w.idle_timeout_secs)
  AND NOT EXISTS (
    SELECT 1
    FROM workspace_sessions s
    WHERE s.workspace_id = w.id
      AND s.status IN ('pending', 'starting', 'running')
      AND NOW() <= s.last_activity_at + make_interval(secs => s.idle_timeout_secs)
  )
  -- Native runs can progress without an attached browser. A bound executor's
  -- running service is an explicit workspace use, not terminal-session idle.
  AND NOT EXISTS (
    SELECT 1 FROM repo_gateways g
    WHERE g.workspace_id = w.id AND g.vm_id = w.vm_id
      AND g.deleted_at IS NULL AND g.status IN ('starting', 'running')
  );

