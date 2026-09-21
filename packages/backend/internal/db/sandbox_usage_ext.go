package db

import (
	"context"
	"time"
)

// SumSandboxAwakeSecondsForUserSince returns elapsed seconds clipped to [since, now).
func (q *Queries) SumSandboxAwakeSecondsForUserSince(ctx context.Context, userID int64, since time.Time) (int64, error) {
	return q.SumSandboxAwakeSecondsForUserSinceRaw(ctx, SumSandboxAwakeSecondsForUserSinceRawParams{UserID: userID, Since: since})
}

// CountActiveAgentSessionVMsForUser excludes a session when either link direction
// identifies a workspace already included by CountActiveSandboxesForUser:
// (w.id = a.workspace_id OR w.agent_session_id = a.id), w.user_id = userID,
// w.deleted_at IS NULL, and w.status IN ('pending', 'starting', 'running').
// Both links matter during provisioning, before the session backlink is saved.
func (q *Queries) CountActiveAgentSessionVMsForUser(ctx context.Context, userID int64) (int64, error) {
	var count int64
	err := q.db.QueryRow(ctx, `
SELECT COUNT(*) FROM agent_sessions a
WHERE a.user_id = $1 AND a.status = 'active'
  AND a.started_at IS NOT NULL AND a.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM workspaces w
    WHERE (w.id = a.workspace_id OR w.agent_session_id = a.id)
      AND w.user_id = $1 AND w.deleted_at IS NULL
      AND w.status IN ('pending', 'starting', 'running')
  )`, userID).Scan(&count)
	return count, err
}
