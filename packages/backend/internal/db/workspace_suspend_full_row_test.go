package db

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// Product suspend returns the row the API serializes and whose
// provisioning_generation keys the runtime stop operation.
func TestHostedSuspendReturnsFullWorkspaceRow(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), uniqueTestRepoName(t))
	ws, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID, UserID: userID, Name: "suspend", Status: "running", Kind: "vm",
	})
	require.NoError(t, err)
	mustExec(t, tx, `UPDATE workspaces SET environment_image = 'image:1', provisioning_generation = 7, provisioning_stage = 'ready' WHERE id = $1`, ws.ID)

	got, err := q.SuspendRunningWorkspaceIfSessionless(ctx, ws.ID)
	require.NoError(t, err)
	require.Equal(t, "suspended", got.Status)
	require.Equal(t, "vm", got.Kind)
	require.Equal(t, "image:1", got.EnvironmentImage)
	require.Equal(t, int32(7), got.ProvisioningGeneration)
	require.Equal(t, "ready", got.ProvisioningStage)
}
