package db

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

// Ported from Plue 667fa74fc (smithersai/plue#528).

func TestWorkspaceProvisionLockReleasedAfterAPIConnectionLoss(t *testing.T) {
	if testing.Short() {
		t.Skip("PostgreSQL integration")
	}
	ctx := context.Background()
	first, err := sharedPool.Acquire(ctx)
	require.NoError(t, err)
	tx, err := first.Begin(ctx)
	require.NoError(t, err)
	acquired, err := New(tx).TryLockWorkspaceProvisioning(ctx, "restart-proof")
	require.NoError(t, err)
	require.True(t, acquired)
	second, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = second.Rollback(ctx) }()
	acquired, err = New(second).TryLockWorkspaceProvisioning(ctx, "restart-proof")
	require.NoError(t, err)
	require.False(t, acquired)
	// Closing the owning connection models process loss, not graceful unlock.
	require.NoError(t, first.Conn().Close(ctx))
	first.Release()
	require.Eventually(t, func() bool {
		acquired, err = New(second).TryLockWorkspaceProvisioning(ctx, "restart-proof")
		require.NoError(t, err)
		return acquired
	}, time.Second, 10*time.Millisecond)
}

func TestProvisionRecoveryFindsRowsAndSettlesOnlyPendingSessions(t *testing.T) {
	if testing.Short() {
		t.Skip("PostgreSQL integration")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	q := New(tx)
	owner := uniqueTestUsername(t)
	user := mustCreateUser(t, tx, owner)
	repo := mustCreateRepoForUser(t, tx, user, "rollout-recovery")
	ws, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{RepositoryID: repo, UserID: user, Name: "restart", TargetBookmark: "main", Status: "starting"})
	require.NoError(t, err)

	listed := func() bool {
		rows, err := q.ListWorkspaceProvisioningRecovery(ctx)
		require.NoError(t, err)
		for _, row := range rows {
			if row.ID == ws.ID {
				require.Equal(t, owner, row.RepositoryOwner)
				require.Equal(t, "rollout-recovery", row.RepositoryName)
				require.Equal(t, "main", row.TargetBookmark)
				return true
			}
		}
		return false
	}
	// A live provisioner's fresh row belongs to it until the grace passes.
	require.False(t, listed())
	_, err = tx.Exec(ctx, "UPDATE workspaces SET updated_at=now()-interval '11 minutes' WHERE id=$1", ws.ID)
	require.NoError(t, err)
	require.True(t, listed())

	session, err := q.CreateWorkspaceSession(ctx, CreateWorkspaceSessionParams{WorkspaceID: ws.ID, RepositoryID: repo, UserID: user, Cols: 80, Rows: 24})
	require.NoError(t, err)
	ids, err := q.CompletePendingWorkspaceSessions(ctx, ws.ID)
	require.NoError(t, err)
	require.Empty(t, ids)
	_, err = q.UpdateWorkspaceExecutionInfo(ctx, UpdateWorkspaceExecutionInfoParams{ID: ws.ID, VmID: "same-vm", Status: "running"})
	require.NoError(t, err)
	// A running workspace with a pending session is listed regardless of age.
	require.True(t, listed())
	ids, err = q.CompletePendingWorkspaceSessions(ctx, ws.ID)
	require.NoError(t, err)
	require.Equal(t, []string{session.ID}, ids)
	ids, err = q.CompletePendingWorkspaceSessions(ctx, ws.ID)
	require.NoError(t, err)
	require.Empty(t, ids)
	require.False(t, listed())
}
