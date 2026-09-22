package deploymentdb

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mustCreateSandboxInstance inserts a placement row attributed to a product
// owner, aged past the sweep's minimum so the query considers it.
func mustCreateSandboxInstance(t *testing.T, pool DBTX, id, kind, resourceID string) {
	t.Helper()
	mustExec(t, pool, `
		INSERT INTO sandbox_instances (
			id, provider, provider_local_id, observed_state, resource_kind, resource_id, created_at
		) VALUES ($1,'microsandbox',$1,'running',$2,$3, NOW() - INTERVAL '2 hours')`,
		id, kind, resourceID)
}

// ListOrphanedSandboxInstances is the backstop for the delete-orphans-a-VM
// leak: repositories(id) cascades away both repo_gateways and workspaces, and
// the gateway/workspace reapers can only iterate the rows that just vanished.
// The VM's own attribution is the last handle left.
func TestListOrphanedSandboxInstances_FindsVMsWhoseOwnerRowIsGone(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	gateway, err := q.CreateRepoGateway(ctx, CreateRepoGatewayParams{
		RepositoryID: repoID, UserID: userID, Status: "running",
	})
	require.NoError(t, err)
	var workspaceID string
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO workspaces (repository_id, user_id, status, vm_id)
		VALUES ($1,$2,'running','msb_ws_live') RETURNING id::text`, repoID, userID).Scan(&workspaceID))

	mustCreateSandboxInstance(t, pool, "msb_gw_live", "repo_gateway", gateway.ID)
	mustCreateSandboxInstance(t, pool, "msb_ws_live", "workspace", workspaceID)
	// Kinds with their own lifecycle must never be touched by this sweep.
	mustCreateSandboxInstance(t, pool, "msb_agent", "agent_session", "session-1")
	// A blank attribution can never be matched to an owner; skipping beats
	// deleting a VM on no evidence.
	mustCreateSandboxInstance(t, pool, "msb_unattributed", "workspace", "")

	orphans, err := q.ListOrphanedSandboxInstances(ctx, ListOrphanedSandboxInstancesParams{
		MinAgeSeconds: 1800, MaxRows: 50,
	})
	require.NoError(t, err)
	assert.Empty(t, orphanIDs(orphans), "nothing is orphaned while both owner rows are live")

	// A durable repository deletion takes the gateway and workspace rows with
	// it, leaving both VMs for the orphan sweep.
	mustDurablyDeleteRepoForTest(t, pool, repoID)

	orphans, err = q.ListOrphanedSandboxInstances(ctx, ListOrphanedSandboxInstancesParams{
		MinAgeSeconds: 1800, MaxRows: 50,
	})
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"msb_gw_live", "msb_ws_live"}, orphanIDs(orphans))

	// A VM younger than the guard is a provision that may still be in flight.
	fresh, err := q.ListOrphanedSandboxInstances(ctx, ListOrphanedSandboxInstancesParams{
		MinAgeSeconds: 24 * 3600, MaxRows: 50,
	})
	require.NoError(t, err)
	assert.Empty(t, orphanIDs(fresh))

	// A tombstoned instance is already reclaimed.
	mustExec(t, pool, `UPDATE sandbox_instances SET deleted_at = NOW() WHERE id = 'msb_gw_live'`)
	remaining, err := q.ListOrphanedSandboxInstances(ctx, ListOrphanedSandboxInstancesParams{
		MinAgeSeconds: 1800, MaxRows: 50,
	})
	require.NoError(t, err)
	assert.Equal(t, []string{"msb_ws_live"}, orphanIDs(remaining))
}

func orphanIDs(rows []ListOrphanedSandboxInstancesRow) []string {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return ids
}
