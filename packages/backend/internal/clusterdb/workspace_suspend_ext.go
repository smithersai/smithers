package clusterdb

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// clusterWorkspaceReturningColumns names every column db.Workspace carries, in
// model order. Naming them keeps the scan independent of the hosted table's
// physical column order; a column missing here reaches the client as its zero
// value.
const clusterWorkspaceReturningColumns = `w.id, w.repository_id, w.user_id, w.name, w.is_fork, w.parent_workspace_id, w.target_bookmark, w.source_snapshot_id, w.kind, w.environment_source, w.environment_revision, w.environment_closure_hash, w.agent_session_id, w.head_push_token_id, w.environment_image, w.desktop_session_id, w.desktop_session_token_hash, w.desktop_session_expires_at, w.vm_id, w.provisioning_generation, w.status, w.failure_code, w.failure_message, w.provisioning_stage, w.last_activity_at, w.idle_timeout_secs, w.suspended_at, w.started_at, w.resumed_at, w.head_change_id, w.head_commit_id, w.ahead, w.behind, w.last_accessed_at, w.deleted_at, w.created_at, w.updated_at`

func scanClusterWorkspaceRow(row pgx.Row) (Workspace, error) {
	var i Workspace
	err := row.Scan(
		&i.ID, &i.RepositoryID, &i.UserID, &i.Name, &i.IsFork, &i.ParentWorkspaceID,
		&i.TargetBookmark, &i.SourceSnapshotID, &i.Kind, &i.EnvironmentSource,
		&i.EnvironmentRevision, &i.EnvironmentClosureHash, &i.AgentSessionID,
		&i.HeadPushTokenID, &i.EnvironmentImage, &i.DesktopSessionID,
		&i.DesktopSessionTokenHash, &i.DesktopSessionExpiresAt, &i.VmID,
		&i.ProvisioningGeneration, &i.Status, &i.FailureCode, &i.FailureMessage,
		&i.ProvisioningStage, &i.LastActivityAt, &i.IdleTimeoutSecs, &i.SuspendedAt,
		&i.StartedAt, &i.ResumedAt, &i.HeadChangeID, &i.HeadCommitID, &i.Ahead,
		&i.Behind, &i.LastAccessedAt, &i.DeletedAt, &i.CreatedAt, &i.UpdatedAt,
	)
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
