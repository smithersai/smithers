package db

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWorkspaceTombstoneStopsAndRejectsSessions(t *testing.T) {
	ctx := context.Background()
	q := New(sharedPool)
	ownerID, repoID := mustCreateUserAndRepo(t, sharedPool, uniqueTestUsername(t), uniqueTestRepoName(t))
	workspace := workspaceSQLHCreateWorkspace(t, q, repoID, ownerID, "tombstone-sessions", "running", false)

	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, workspace.ID)
	})

	pending, err := q.CreateWorkspaceSession(ctx, CreateWorkspaceSessionParams{
		WorkspaceID: workspace.ID, RepositoryID: repoID, UserID: ownerID, Cols: 80, Rows: 24,
	})
	require.NoError(t, err)
	running, err := q.CreateWorkspaceSession(ctx, CreateWorkspaceSessionParams{
		WorkspaceID: workspace.ID, RepositoryID: repoID, UserID: ownerID, Cols: 100, Rows: 40,
	})
	require.NoError(t, err)
	_, err = q.MarkWorkspaceSessionRunning(ctx, running.ID)
	require.NoError(t, err)

	deleted, err := q.SoftDeleteWorkspace(ctx, workspace.ID)
	require.NoError(t, err)
	assert.True(t, deleted.DeletedAt.Valid)
	assert.Equal(t, "stopped", deleted.Status)

	for _, sessionID := range []string{pending.ID, running.ID} {
		session, getErr := q.GetWorkspaceSession(ctx, sessionID)
		require.NoError(t, getErr)
		assert.Equal(t, "stopped", session.Status)
	}
	active, err := q.CountActiveSessionsForWorkspace(ctx, workspace.ID)
	require.NoError(t, err)
	assert.Zero(t, active)

	_, err = q.CreateWorkspaceSession(ctx, CreateWorkspaceSessionParams{
		WorkspaceID: workspace.ID, RepositoryID: repoID, UserID: ownerID, Cols: 80, Rows: 24,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	// Previous-version binaries issue a direct INSERT without the new locking
	// CTE. The database trigger must enforce the same rollout-safe fence.
	var staleSessionID string
	err = sharedPool.QueryRow(ctx, `
		INSERT INTO workspace_sessions (workspace_id, repository_id, user_id, cols, rows)
		VALUES ($1, $2, $3, 80, 24)
		RETURNING id
	`, workspace.ID, repoID, ownerID).Scan(&staleSessionID)
	require.ErrorIs(t, err, pgx.ErrNoRows)

	result, err := sharedPool.Exec(ctx, `
		UPDATE workspace_sessions
		SET status = 'running', updated_at = NOW()
		WHERE id = $1
	`, pending.ID)
	require.NoError(t, err)
	assert.Zero(t, result.RowsAffected(), "a detached old provisioner must not resurrect a stopped session")
}

func TestWorkspaceTombstoneSerializesConcurrentSessionCreation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	q := New(sharedPool)
	ownerID, repoID := mustCreateUserAndRepo(t, sharedPool, uniqueTestUsername(t), uniqueTestRepoName(t))

	createWins := workspaceSQLHCreateWorkspace(t, q, repoID, ownerID, "create-wins", "running", false)
	deleteWins := workspaceSQLHCreateWorkspace(t, q, repoID, ownerID, "delete-wins", "running", true)
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workspaces WHERE id IN ($1, $2)`, createWins.ID, deleteWins.ID)
	})

	creatorTx, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	creatorQ := New(creatorTx)
	created, err := creatorQ.CreateWorkspaceSession(ctx, CreateWorkspaceSessionParams{
		WorkspaceID: createWins.ID, RepositoryID: repoID, UserID: ownerID, Cols: 80, Rows: 24,
	})
	require.NoError(t, err)

	type deleteResult struct {
		workspace Workspace
		err       error
	}
	deleteDone := make(chan deleteResult, 1)
	go func() {
		workspace, deleteErr := q.SoftDeleteWorkspace(ctx, createWins.ID)
		deleteDone <- deleteResult{workspace: workspace, err: deleteErr}
	}()

	select {
	case result := <-deleteDone:
		t.Fatalf("tombstone did not serialize behind the in-flight creator: %v", result.err)
	case <-time.After(100 * time.Millisecond):
	}
	require.NoError(t, creatorTx.Commit(ctx))
	result := <-deleteDone
	require.NoError(t, result.err)
	assert.True(t, result.workspace.DeletedAt.Valid)
	createdAfterDelete, err := q.GetWorkspaceSession(ctx, created.ID)
	require.NoError(t, err)
	assert.Equal(t, "stopped", createdAfterDelete.Status, "a creator that commits first must be stopped by the waiting tombstone")

	deleterTx, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	deleterQ := New(deleterTx)
	_, err = deleterQ.SoftDeleteWorkspace(ctx, deleteWins.ID)
	require.NoError(t, err)

	createDone := make(chan error, 1)
	go func() {
		_, createErr := q.CreateWorkspaceSession(ctx, CreateWorkspaceSessionParams{
			WorkspaceID: deleteWins.ID, RepositoryID: repoID, UserID: ownerID, Cols: 80, Rows: 24,
		})
		createDone <- createErr
	}()

	select {
	case createErr := <-createDone:
		t.Fatalf("session creation did not serialize behind the in-flight tombstone: %v", createErr)
	case <-time.After(100 * time.Millisecond):
	}
	require.NoError(t, deleterTx.Commit(ctx))
	err = <-createDone
	assert.True(t, errors.Is(err, pgx.ErrNoRows), "a tombstone that commits first must reject the waiting creator")
}
