package services

// Workspace resume must recover when the controller reports that a persisted
// sandbox no longer exists or cannot be resumed.

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// A missing sandbox on the no-input resume path advises a fresh create instead
// of retrying a resource the controller has already forgotten.
func TestWorkspaceService_EnsureExistingWorkspaceRunning_TreatsMissingSandboxAsGone(t *testing.T) {
	t.Parallel()

	realClient := &mockWorkspaceSandboxVMClient{getVMFn: func(context.Context, string) (sandbox.Sandbox, error) { return sandbox.Sandbox{}, sandbox.ErrNotFound }}

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(realClient))

	ws := sampleDBWorkspace("ws-deleted")
	ws.Status = "suspended"
	ws.VmID = "czly94117m21u5s8h94x"

	_, err := svc.ensureExistingWorkspaceRunning(context.Background(), ws)
	require.Error(t, err)

	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "a missing sandbox must map to an APIError, got %T: %v", err, err)
	assert.Equal(t, 409, apiErr.Status, "a gone sandbox on the no-input path must be a Conflict, not a bare Internal")
	assert.Contains(t, apiErr.Message, "smithers workspace create")
}

// A hard, non-timeout controller failure from StartSandbox that
// persists across the single retry must fall through to reprovision when input
// is available — an unresumable VM is as good as gone. The workspace must reach
// 'running' on a fresh replacement VM instead of returning Internal forever.
func TestWorkspaceService_CreateWorkspace_ReprovisionsOnHardResumeFailure(t *testing.T) {
	t.Parallel()

	var updatedStatuses []string
	var executionUpdates []db.UpdateWorkspaceExecutionInfoParams
	q := &mockWorkspaceQuerier{
		getActiveWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace("ws-primary")
			workspace.VmID = "sandbox-unresumable"
			workspace.Status = "suspended"
			return workspace, nil
		},
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			updatedStatuses = append(updatedStatuses, arg.Status)
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = "sandbox-unresumable"
			workspace.Status = arg.Status
			return workspace, nil
		},
		suspendRunningWorkspaceFn: func(ctx context.Context, id string) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			executionUpdates = append(executionUpdates, arg)
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = arg.VmID
			workspace.Status = arg.Status
			return workspace, nil
		},
	}

	var startCalls int
	var deletedVMs []string
	svc := newWorkspaceServiceForTests(
		q,
		WithWorkspaceGitBaseURL("https://api.smithers.sh"),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
				return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
			},
			deleteVMFn: func(ctx context.Context, vmID string) error {
				deletedVMs = append(deletedVMs, vmID)
				return nil
			},
			startVMFn: func(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error) {
				startCalls++
				// The unresumable snapshot returns a hard controller failure every time.
				return sandbox.StartResult{}, &sandbox.StatusError{
					StatusCode: 500,
					Message:    "sandbox runtime could not restore " + vmID,
				}
			},
			createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
				return sandbox.CreateResult{ID: "vm-replacement"}, nil
			},
			execAwaitFn: func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
				status := int32(0)
				return sandbox.ExecResult{StatusCode: &status}, nil
			},
		}),
	)

	workspace, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "roninjin10",
		RepoName:     "smithers",
		Name:         "primary",
	})
	require.NoError(t, err)
	assert.GreaterOrEqual(t, startCalls, 2, "a hard 500 must be retried once before giving up on the VM")
	require.NotEmpty(t, executionUpdates)
	assert.Equal(t, "", executionUpdates[0].VmID, "reprovision must reset the row so the replacement VM can register")
	assert.Equal(t, "starting", executionUpdates[0].Status)
	assert.Contains(t, deletedVMs, "sandbox-unresumable", "the unresumable sandbox must be reaped")
	assert.NotContains(t, deletedVMs, "vm-replacement")
	assert.Equal(t, "vm-replacement", workspace.VMID)
	assert.Equal(t, "running", workspace.Status)
	assert.Empty(t, updatedStatuses, "reprovision must not mark the workspace failed")
}

// A single transient 500 from StartSandbox must be absorbed by the immediate retry:
// the VM resumes on the second attempt and must NOT be replaced. This protects
// genuinely flaky resumes from unnecessary (data-losing) VM reprovisioning.
func TestWorkspaceService_CreateWorkspace_RetryResumeSavesVM(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getActiveWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace("ws-flaky")
			workspace.VmID = "vm-flaky"
			workspace.Status = "suspended"
			return workspace, nil
		},
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = "vm-flaky"
			workspace.Status = arg.Status
			return workspace, nil
		},
	}

	var startCalls int
	createVMCalled := false
	svc := newWorkspaceServiceForTests(
		q,
		WithWorkspaceGitBaseURL("https://api.smithers.sh"),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
				return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
			},
			startVMFn: func(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error) {
				startCalls++
				if startCalls == 1 {
					return sandbox.StartResult{}, &sandbox.StatusError{StatusCode: 500, Message: "transient"}
				}
				return sandbox.StartResult{ID: vmID}, nil
			},
			createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
				createVMCalled = true
				return sandbox.CreateResult{ID: "vm-should-not-exist"}, nil
			},
		}),
	)

	workspace, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "roninjin10",
		RepoName:     "smithers",
		Name:         "primary",
	})
	require.NoError(t, err)
	assert.Equal(t, 2, startCalls, "the resume must be retried exactly once and then succeed")
	assert.False(t, createVMCalled, "a retry that succeeds must NOT reprovision a fresh VM")
	assert.Equal(t, "vm-flaky", workspace.VMID, "the original VM must be preserved")
	assert.Equal(t, "running", workspace.Status)
}

// A detached provisioning goroutine that fails must drive the workspace to the
// terminal 'failed' status so pollers stop hanging (the multi client treats
// state 'failed'/'error' as terminal). Currently it only logs, so the row keeps
// its non-terminal status and clients hang until their own 4-minute deadline.
func TestWorkspaceService_ProvisionWorkspaceAsync_MarksFailedOnError(t *testing.T) {
	t.Parallel()

	failedCh := make(chan struct{}, 1)
	q := &mockWorkspaceQuerier{
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			if arg.Status == "failed" {
				select {
				case failedCh <- struct{}{}:
				default:
				}
			}
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = "vm-broken"
			workspace.Status = arg.Status
			return workspace, nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			// A hard, non-recoverable InspectSandbox failure (not a gone VM) — ensureWorkspaceRunning returns Internal.
			return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: 500, Message: "internal"}
		},
	}))

	ws := sampleDBWorkspace("ws-async")
	ws.VmID = "vm-broken"
	ws.Status = "starting"

	svc.provisionWorkspaceAsync(context.Background(), ws, CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "roninjin10",
		RepoName:     "smithers",
	})

	select {
	case <-failedCh:
		// fixed behavior: the row reached 'failed'.
	case <-time.After(3 * time.Second):
		t.Fatal("async provisioning failure never marked the workspace 'failed'; pollers would hang")
	}
}
