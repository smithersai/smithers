package services

// Reprovisioning a workspace whose VM the controller has forgotten must be a
// NEW logical sandbox operation, not a replay of the create that already
// succeeded.
//
// Production, 2026-09-15 13:30Z (API image 8f08c257): a sandbox worker rollout
// during a deploy killed the VM behind a kind=vm workspace. The create-or-reuse
// route returned that same workspace and the API logged
//
//	WARNING workspace resume failed; reprovisioning sandbox … error: microsandbox
//	api returned status 404 (not_found): Microsandbox worker operation failed
//	ERROR async workspace provisioning failed … error: create sandbox: microsandbox
//	api returned status 409 (idempotency_conflict): idempotency key was reused for
//	a different request
//
// because the replacement create re-derived the original create's
// Idempotency-Key while sending a different body. The workspace died 'failed'
// and every later open answered "workspace VM has not been provisioned".

import (
	"context"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// reprovisionQuerier is a single-row workspace store: it keeps the state the
// idempotency key is derived from (vm_id, status, provisioning_generation)
// across the two CreateWorkspace calls a reprovision needs.
type reprovisionQuerier struct {
	*mockWorkspaceQuerier
	mu     sync.Mutex
	row    db.Workspace
	resets int
}

func newReprovisionQuerier(row db.Workspace) *reprovisionQuerier {
	q := &reprovisionQuerier{row: row}
	q.mockWorkspaceQuerier = &mockWorkspaceQuerier{
		getActiveWorkspaceForUserRepoFn: func(context.Context, db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			return q.current(), nil
		},
		getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			return q.current(), nil
		},
		suspendRunningWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
		updateWorkspaceStatusFn: func(_ context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			q.mu.Lock()
			defer q.mu.Unlock()
			q.row.Status = arg.Status
			return q.row, nil
		},
		updateWorkspaceExecutionInfoFn: func(_ context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			q.mu.Lock()
			defer q.mu.Unlock()
			q.row.VmID = arg.VmID
			q.row.Status = arg.Status
			return q.row, nil
		},
	}
	return q
}

func (q *reprovisionQuerier) current() db.Workspace {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.row
}

// ResetWorkspaceForReprovision mirrors the real statement: clear the dead
// vm_id, return to 'starting', and open the next provisioning generation.
func (q *reprovisionQuerier) ResetWorkspaceForReprovision(_ context.Context, id string) (db.Workspace, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if id != q.row.ID {
		return db.Workspace{}, pgx.ErrNoRows
	}
	q.resets++
	q.row.VmID = ""
	q.row.Status = "starting"
	q.row.ProvisioningGeneration++
	return q.row, nil
}

// A reprovision after the controller reports the VM gone must present a
// DIFFERENT idempotency key than the create that produced the dead VM, clear
// the stale vm_id, land the replacement VM on the row, and leave the workspace
// running — the exact sequence that 409'd in production.
func TestWorkspaceService_ReprovisionAfterNotFound_UsesFreshIdempotencyKey(t *testing.T) {
	t.Parallel()

	row := sampleDBWorkspace("ws-reprovision")
	row.VmID = ""
	row.Status = "pending"
	q := newReprovisionQuerier(row)

	var (
		mu           sync.Mutex
		createKeys   []string
		createdVMs   []string
		deletedVMs   []string
		vmSequence   int
		vmIsReclaimd bool
	)

	svc := newWorkspaceServiceForTests(
		q,
		WithWorkspaceGitBaseURL("https://api.smithers.sh"),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			createVMFn: func(ctx context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
				key, err := sandbox.RequestIdempotencyKey(ctx)
				require.NoError(t, err)
				mu.Lock()
				defer mu.Unlock()
				vmSequence++
				createKeys = append(createKeys, key)
				id := "vm-" + string(rune('0'+vmSequence))
				createdVMs = append(createdVMs, id)
				return sandbox.CreateResult{ID: id}, nil
			},
			getVMFn: func(_ context.Context, vmID string) (sandbox.Sandbox, error) {
				mu.Lock()
				reclaimed := vmIsReclaimd
				mu.Unlock()
				if reclaimed {
					// The worker rollout took the VM with it.
					return sandbox.Sandbox{}, &sandbox.StatusError{
						StatusCode: 404,
						ErrorCode:  "not_found",
						Message:    "Microsandbox worker operation failed",
					}
				}
				return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
			},
			deleteVMFn: func(_ context.Context, vmID string) error {
				mu.Lock()
				defer mu.Unlock()
				deletedVMs = append(deletedVMs, vmID)
				return nil
			},
		}),
	)

	input := CreateWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "roninjin10",
		RepoName:     "smithers",
		Name:         "primary",
	}

	first, err := svc.CreateWorkspace(context.Background(), input)
	require.NoError(t, err)
	require.Equal(t, "vm-1", first.VMID)
	require.Equal(t, "running", first.Status)

	mu.Lock()
	vmIsReclaimd = true
	mu.Unlock()

	second, err := svc.CreateWorkspace(context.Background(), input)
	require.NoError(t, err)

	mu.Lock()
	defer mu.Unlock()
	require.Len(t, createKeys, 2, "the reprovision must issue its own create")
	assert.NotEqual(t, createKeys[0], createKeys[1],
		"a reprovision sends a different body (fresh image/closure, fresh sandbox name), so reusing the first create's key is a controller 409 idempotency_conflict")
	assert.Equal(t, 1, q.resets, "the dead vm_id must be cleared through the generation-advancing reset")
	assert.Equal(t, int32(1), q.current().ProvisioningGeneration)

	assert.Equal(t, "vm-2", second.VMID, "the replacement VM must land on the row")
	assert.Equal(t, "running", second.Status, "the workspace must not be left 'failed'")
	assert.Contains(t, deletedVMs, "vm-1", "the forgotten VM must be reaped")
	assert.NotContains(t, deletedVMs, "vm-2", "the orphan sweep must never reclaim the replacement VM")
}

// Retrying the SAME attempt must converge on one sandbox: the key is derived
// from the persisted generation, so it only moves when a reprovision advances
// that generation. Without this, every retry would allocate a second VM.
func TestWorkspaceProvisionAttempt_RetryOfOneAttemptReusesKey(t *testing.T) {
	t.Parallel()

	var keys []string
	svc := newWorkspaceServiceForTests(
		&mockWorkspaceQuerier{},
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			createVMFn: func(ctx context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
				key, err := sandbox.RequestIdempotencyKey(ctx)
				require.NoError(t, err)
				keys = append(keys, key)
				return sandbox.CreateResult{ID: "vm-retry"}, nil
			},
		}),
	)

	for _, generation := range []int32{0, 0, 1} {
		_, err := svc.createFreshWorkspaceVM(context.Background(), 101, "ws-retry", generation, "container")
		require.NoError(t, err)
	}

	require.Len(t, keys, 3)
	assert.Equal(t, keys[0], keys[1], "an identical retry within one attempt must reuse the attempt's key")
	assert.NotEqual(t, keys[0], keys[2], "the next provisioning generation must be a new logical operation")
}
