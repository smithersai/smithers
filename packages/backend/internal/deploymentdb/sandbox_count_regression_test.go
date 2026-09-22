package deploymentdb

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Regression for the 2026-07-08 prod terminal outage: suspended gateway VMs
// counted toward the per-user concurrent-sandbox cap while suspended
// workspaces did not, so a user's idle durable gateways silently starved
// terminal/workspace provisioning. Only VMs that consume compute
// (pending/starting/running workspaces, starting/running gateways with a VM)
// plus pending gateway rows — durable provision reservations — may count.
func TestCountActiveSandboxesForUser_CountsOnlyComputeConsumingVMs(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))

	// uq_workspaces_active permits one non-failed workspace per (repo, user),
	// so every workspace (and gateway) gets its own repo.
	nextRepo := func() int64 {
		return mustCreateRepo(t, pool, userID, uniqueTestRepoName(t))
	}
	insertWorkspace := func(status string) {
		_, err := pool.Exec(ctx,
			`INSERT INTO workspaces (repository_id, user_id, status) VALUES ($1, $2, $3)`,
			nextRepo(), userID, status)
		require.NoError(t, err)
	}

	baseline, err := q.CountActiveSandboxesForUser(ctx, userID)
	require.NoError(t, err)
	require.Equal(t, 0, baseline)

	// Compute-consuming workspaces count; suspended/failed do not.
	insertWorkspace("pending")
	insertWorkspace("starting")
	insertWorkspace("running")
	insertWorkspace("suspended")
	insertWorkspace("failed")

	n, err := q.CountActiveSandboxesForUser(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, 3, n, "only pending/starting/running workspaces consume compute")

	// A running gateway with a live VM counts on top.
	_, err = pool.Exec(ctx,
		`INSERT INTO repo_gateways (repository_id, user_id, vm_id, status) VALUES ($1, $2, 'vm-live', 'running')`,
		nextRepo(), userID)
	require.NoError(t, err)

	n, err = q.CountActiveSandboxesForUser(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, 4, n, "running gateway VM must count toward the cap")
}

// A suspended gateway holds disk, not compute — it must not eat a sandbox
// slot (workspaces already follow this rule). Separate test because the
// partial unique index permits only one live gateway per user+repo.
func TestCountActiveSandboxesForUser_SuspendedGatewayDoesNotCount(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	_, err := pool.Exec(ctx,
		`INSERT INTO repo_gateways (repository_id, user_id, vm_id, status) VALUES ($1, $2, 'vm-suspended', 'suspended')`,
		repoID, userID)
	require.NoError(t, err)

	n, err := q.CountActiveSandboxesForUser(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, 0, n, "suspended gateway VMs hold disk only and must not consume a sandbox slot")
}

// A non-pending gateway row without a provisioned VM (vm_id = ”) never
// counts — but a 'pending' row does: it is the durable reservation a provision
// inserts BEFORE its concurrency-cap check, so two racing provisions see each
// other instead of both passing a stale count (plue#302).
func TestCountActiveSandboxesForUser_GatewayWithoutVMDoesNotCount(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	_, err := pool.Exec(ctx,
		`INSERT INTO repo_gateways (repository_id, user_id, vm_id, status) VALUES ($1, $2, '', 'running')`,
		repoID, userID)
	require.NoError(t, err)

	n, err := q.CountActiveSandboxesForUser(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, 0, n, "non-pending gateway rows without a live VM must not count")
}

// A 'pending' gateway row is a provision reservation and must count even
// though no VM exists yet (plue#302: concurrent provisions bypassed the cap).
func TestCountActiveSandboxesForUser_PendingGatewayReservationCounts(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	_, err := pool.Exec(ctx,
		`INSERT INTO repo_gateways (repository_id, user_id, vm_id, status) VALUES ($1, $2, '', 'pending')`,
		repoID, userID)
	require.NoError(t, err)

	n, err := q.CountActiveSandboxesForUser(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, 1, n, "pending gateway reservations must count toward the cap")
}
