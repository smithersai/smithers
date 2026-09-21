package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// SoftDeleteWorkspace promises that lingering readers see a terminal stopped
// row. Detached provisioning can finish after a concurrent DELETE, so every
// operational workspace update must reject the tombstone instead of reviving
// it or changing its terminal status/stage/recency.
func TestWorkspaceOperationalUpdatesDoNotMutateTombstone(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	workspace := workspaceSQLHCreateWorkspace(t, q, repoID, userID, "tombstone", "starting", true)
	workspace, err := q.UpdateWorkspaceExecutionInfo(ctx, UpdateWorkspaceExecutionInfoParams{
		ID: workspace.ID, VmID: "vm-original", Status: "running",
	})
	require.NoError(t, err)
	workspace, err = q.UpdateWorkspaceProvisioningStage(ctx, UpdateWorkspaceProvisioningStageParams{
		ID: workspace.ID, ProvisioningStage: "ready",
	})
	require.NoError(t, err)
	workspace, err = q.UpdateWorkspaceTargetBookmark(ctx, UpdateWorkspaceTargetBookmarkParams{
		ID: workspace.ID, TargetBookmark: "feature/original",
	})
	require.NoError(t, err)

	deleted, err := q.SoftDeleteWorkspace(ctx, workspace.ID)
	require.NoError(t, err)
	require.True(t, deleted.DeletedAt.Valid)
	require.Equal(t, "stopped", deleted.Status)

	_, err = q.UpdateWorkspaceStatus(ctx, UpdateWorkspaceStatusParams{ID: workspace.ID, Status: "failed"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateWorkspaceProvisioningStage(ctx, UpdateWorkspaceProvisioningStageParams{ID: workspace.ID, ProvisioningStage: "environment_setup_failed"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateWorkspaceExecutionInfo(ctx, UpdateWorkspaceExecutionInfoParams{ID: workspace.ID, VmID: "vm-late", Status: "running"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateWorkspaceTargetBookmark(ctx, UpdateWorkspaceTargetBookmarkParams{ID: workspace.ID, TargetBookmark: "feature/late"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.SuspendRunningWorkspace(ctx, workspace.ID)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	require.NoError(t, q.TouchWorkspaceActivity(ctx, workspace.ID))
	require.NoError(t, q.TouchWorkspaceLastAccessed(ctx, workspace.ID))

	after, err := q.GetWorkspaceIncludingDeleted(ctx, workspace.ID)
	require.NoError(t, err)
	assert.Equal(t, deleted.Status, after.Status)
	assert.Equal(t, deleted.VmID, after.VmID)
	assert.Equal(t, deleted.ProvisioningStage, after.ProvisioningStage)
	assert.Equal(t, deleted.TargetBookmark, after.TargetBookmark)
	assert.Equal(t, deleted.LastActivityAt, after.LastActivityAt)
	assert.Equal(t, deleted.LastAccessedAt, after.LastAccessedAt)
	assert.Equal(t, deleted.UpdatedAt, after.UpdatedAt)
}
