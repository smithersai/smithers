package db

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"
)

// The workspace CAS transitions return the row the API serializes. A narrow
// projection used to blank every column after updated_at on resume/suspend.
func TestWorkspaceCASTransitionsReturnFullRow(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), uniqueTestRepoName(t))
	sessionID := uuid.NewString()
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID: sessionID, RepositoryID: repoID, UserID: userID, Title: "cas", Status: "active",
	})
	require.NoError(t, err)
	var agentSession pgtype.UUID
	require.NoError(t, agentSession.Scan(sessionID))
	ws, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID, UserID: userID, Name: "cas", Status: "running",
		Kind: "vm", AgentSessionID: agentSession,
	})
	require.NoError(t, err)
	require.NoError(t, q.SetWorkspaceEnvironmentImage(ctx, SetWorkspaceEnvironmentImageParams{
		ID: ws.ID, EnvironmentRevision: "rev", EnvironmentClosureHash: "hash", EnvironmentImage: "image:1",
	}))
	_, err = tx.Exec(ctx, `UPDATE workspaces SET provisioning_generation = 7, provisioning_stage = 'ready' WHERE id = $1`, ws.ID)
	require.NoError(t, err)

	assertFull := func(t *testing.T, got Workspace) {
		t.Helper()
		require.Equal(t, "vm", got.Kind)
		require.Equal(t, "image:1", got.EnvironmentImage)
		require.Equal(t, agentSession, got.AgentSessionID)
		require.Equal(t, int32(7), got.ProvisioningGeneration)
		require.Equal(t, "ready", got.ProvisioningStage)
	}

	suspended, err := q.SuspendRunningWorkspaceIfSessionless(ctx, ws.ID)
	require.NoError(t, err)
	require.Equal(t, "suspended", suspended.Status)
	assertFull(t, suspended)

	resumed, err := q.ResumeWorkspaceToRunning(ctx, ws.ID)
	require.NoError(t, err)
	require.Equal(t, "running", resumed.Status)
	assertFull(t, resumed)

	_, err = tx.Exec(ctx, `UPDATE workspaces SET status = 'starting', vm_id = 'vm-1', updated_at = NOW() - interval '1 hour' WHERE id = $1`, ws.ID)
	require.NoError(t, err)
	stale, err := q.ListStaleStartingWorkspacesWithVM(ctx, 60)
	require.NoError(t, err)
	require.Len(t, stale, 1)
	assertFull(t, stale[0])

	failed, err := q.FailStaleStartingWorkspace(ctx, FailStaleStartingWorkspaceParams{ID: ws.ID, StaleAfterSecs: 60})
	require.NoError(t, err)
	require.Equal(t, "failed", failed.Status)
	assertFull(t, failed)
}
