package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// provisioningTestQuerier returns a mock querier wired for the fresh-primary
// create path: no existing workspace, quota available, and CreateWorkspace
// yields a "starting" row with no VM yet (so ensureWorkspaceRunning drives a
// fresh CreateSandbox rather than a resume).
func provisioningTestQuerier(sessionStatuses *[]string) *mockWorkspaceQuerier {
	return &mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(ctx context.Context, arg db.CountWorkspacesByRepoParams) (int64, error) {
			return 0, nil
		},
		getActiveWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			ws := sampleDBWorkspace("ws-new")
			ws.VmID = ""
			ws.Status = "starting"
			return ws, nil
		},
		createWorkspaceSessionFn: func(ctx context.Context, arg db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{
				ID:           "sess-1",
				WorkspaceID:  arg.WorkspaceID,
				RepositoryID: arg.RepositoryID,
				UserID:       arg.UserID,
				Status:       "pending",
			}, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			ws := sampleDBWorkspace(arg.ID)
			ws.VmID = arg.VmID
			ws.Status = arg.Status
			return ws, nil
		},
		updateWorkspaceSessionStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceSessionStatusParams) (db.WorkspaceSession, error) {
			if sessionStatuses != nil {
				*sessionStatuses = append(*sessionStatuses, arg.Status)
			}
			return db.WorkspaceSession{ID: arg.ID, WorkspaceID: "ws-new", RepositoryID: 101, UserID: 1, Status: arg.Status}, nil
		},
	}
}

// TestWorkspaceService_CreateSession_DecouplesProvisioningFromRequestCancellation
// reproduces the prod terminal hang/leak: the terminal-session route provisions
// the Microsandbox VM synchronously under the HTTP request context. When the client
// disconnects or a proxy hop hits its deadline (~125s), that context is canceled
// while Microsandbox is still synchronously materializing or bootstrapping the
// guest, so CreateSandbox is invoked with an already-canceled context and the
// booted VM is orphaned.
//
// The fix routes provisioning through a detached/async context so VM creation
// survives request cancellation. This test asserts CreateSandbox never observes the
// canceled request context.
func TestWorkspaceService_CreateSession_DecouplesProvisioningFromRequestCancellation(t *testing.T) {
	t.Parallel()

	// Client has already disconnected: the request context is canceled before
	// provisioning begins, exactly like the ~125s proxy-cancel in prod.
	reqCtx, cancel := context.WithCancel(context.Background())
	cancel()

	createVMCtxErr := make(chan error, 1)
	q := provisioningTestQuerier(nil)
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			select {
			case createVMCtxErr <- ctx.Err():
			default:
			}
			return sandbox.CreateResult{ID: "vm-new"}, nil
		},
	}))

	_, _ = svc.CreateSession(reqCtx, CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
	})

	select {
	case err := <-createVMCtxErr:
		require.NoError(t, err,
			"VM provisioning must be decoupled from the request context; got a canceled context, which is how prod leaks VMs when the client disconnects")
	case <-time.After(3 * time.Second):
		t.Fatal("CreateSandbox was never invoked")
	}
}

// TestWorkspaceService_CreateSession_DeletesVMWhenCreateReturnsIDWithError
// reproduces the VM leak: when CreateSandbox returns a non-empty VM id alongside an
// error (the VM booted on Microsandbox's side but the call still failed, e.g. the
// synchronous provider bootstrap did not finish before cancellation), Plue
// currently
// discards the id and marks the workspace failed WITHOUT deleting the VM. That
// booted 4-vCPU/8GB VM leaks and eventually drives the user into quota_exceeded.
//
// The fix must delete any created-but-unregistered VM on the failure path.
func TestWorkspaceService_CreateSession_DeletesVMWhenCreateReturnsIDWithError(t *testing.T) {
	t.Parallel()

	var sessionStatuses []string
	q := provisioningTestQuerier(&sessionStatuses)

	var deletedVMs []string
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			// VM booted on Microsandbox, but the provisioning call still failed.
			return sandbox.CreateResult{ID: "vm-orphan"}, assert.AnError
		},
		deleteVMFn: func(ctx context.Context, vmID string) error {
			deletedVMs = append(deletedVMs, vmID)
			return nil
		},
	}))

	_, err := svc.CreateSession(context.Background(), CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
	})
	require.Error(t, err)
	assert.Equal(t, []string{"vm-orphan"}, deletedVMs,
		"a VM whose id is known but which could not be registered must be deleted, not leaked")
}
