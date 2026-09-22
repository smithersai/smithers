package clusterdb

import (
	"context"
	"github.com/jackc/pgx/v5"
)

const clusterWorkspaceReturningColumns = `id, repository_id, user_id, name, is_fork, parent_workspace_id, target_bookmark, source_snapshot_id, vm_id, status, last_activity_at, idle_timeout_secs, suspended_at, last_accessed_at, deleted_at, created_at, updated_at`

func scanClusterWorkspaceRow(row pgx.Row) (Workspace, error) {
	var i Workspace
	err := row.Scan(&i.ID, &i.RepositoryID, &i.UserID, &i.Name, &i.IsFork, &i.ParentWorkspaceID, &i.TargetBookmark, &i.SourceSnapshotID, &i.VmID, &i.Status, &i.LastActivityAt, &i.IdleTimeoutSecs, &i.SuspendedAt, &i.LastAccessedAt, &i.DeletedAt, &i.CreatedAt, &i.UpdatedAt)
	return i, err
}

// SuspendRunningWorkspaceIfSessionless CASes a workspace from running to
// suspended, but only while it has no active (pending/starting/running)
// sessions or a live bound repository gateway. A native repository run needs
// no terminal session, so it uses the same gateway fence as idle cleanup.
// The NOT EXISTS gates are evaluated in the same statement as the
// status flip, so a session created concurrently with a last-session destroy
// can never be stranded on a workspace this call just decided to suspend.
func (q *Queries) SuspendRunningWorkspaceIfSessionless(ctx context.Context, id string) (Workspace, error) {
	return scanClusterWorkspaceRow(q.db.QueryRow(ctx, `
UPDATE workspaces w
SET status = 'suspended',
    suspended_at = NOW(),
    updated_at = NOW()
WHERE w.id = $1
  AND w.status = 'running'
  AND w.deleted_at IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM workspace_sessions s
      WHERE s.workspace_id = w.id
        AND s.status IN ('pending', 'starting', 'running')
  )
  AND NOT EXISTS (
      SELECT 1
      FROM repo_gateways g
      WHERE g.workspace_id = w.id AND g.vm_id = w.vm_id
        AND g.deleted_at IS NULL AND g.status IN ('starting', 'running')
  )
RETURNING `+clusterWorkspaceReturningColumns, id))
}
