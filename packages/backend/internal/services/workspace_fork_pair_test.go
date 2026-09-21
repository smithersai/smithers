package services

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// TestForkWorkspace_ResumesSuspendedSourceThenForks pins the EXISTING
// resume-then-fork behavior that Smithers Pair reuses: a suspended (stopped)
// source VM is resumed via StartSandbox before ForkSandbox is called.
func TestForkWorkspace_ResumesSuspendedSourceThenForks(t *testing.T) {
	t.Parallel()

	const sourceID = "ws-source"
	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			ws := sampleDBWorkspace(sourceID)
			ws.Status = "suspended"
			return ws, nil
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			ws := sampleDBWorkspace("ws-fork")
			ws.IsFork = true
			ws.ParentWorkspaceID = arg.ParentWorkspaceID
			ws.VmID = ""
			ws.Status = "starting"
			return ws, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			ws := sampleDBWorkspace(arg.ID)
			ws.IsFork = true
			ws.VmID = arg.VmID
			ws.Status = arg.Status
			return ws, nil
		},
	}

	var resumed, forked atomic.Bool
	getCalls := 0
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			getCalls++
			// First observation: stopped (suspended) -> triggers resume.
			// After StartSandbox the lifecycle poll sees it running.
			if getCalls == 1 {
				return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
			}
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
		},
		startVMFn: func(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error) {
			resumed.Store(true)
			assert.Equal(t, "vm-source-1", vmID)
			return sandbox.StartResult{ID: vmID}, nil
		},
		forkVMFn: func(ctx context.Context, sourceVMID string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
			forked.Store(true)
			assert.Equal(t, "vm-source-1", sourceVMID)
			return sandbox.CreateResult{ID: "vm-forked"}, nil
		},
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			t.Fatalf("CreateSandbox must not be called when the source has a VM to fork")
			return sandbox.CreateResult{}, nil
		},
	}))

	ws, err := svc.ForkWorkspace(context.Background(), ForkWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		WorkspaceID:  sourceID,
		Name:         "pair-fork",
	})
	require.NoError(t, err)
	assert.True(t, resumed.Load(), "a suspended source VM must be resumed before forking")
	assert.True(t, forked.Load(), "ForkSandbox must run against the resumed source VM")
	assert.Equal(t, "vm-forked", ws.VMID)
	assert.True(t, ws.IsFork)
}

// TestForkWorkspace_ProvisionOnEmptySourceCreatesSessionVM proves the new
// provision-on-empty branch: when the source workspace was never provisioned
// (empty VmID) ForkWorkspace no longer 409s — it binds a FRESH VM to the fork
// via CreateSandbox and never calls ForkSandbox.
func TestForkWorkspace_ProvisionOnEmptySourceCreatesSessionVM(t *testing.T) {
	t.Parallel()

	const sourceID = "ws-empty-source"
	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			ws := sampleDBWorkspace(sourceID)
			ws.VmID = "" // never provisioned
			ws.Status = "pending"
			return ws, nil
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			assert.True(t, arg.IsFork, "the session workspace is a fork of the source")
			ws := sampleDBWorkspace("ws-fork")
			ws.IsFork = true
			ws.ParentWorkspaceID = arg.ParentWorkspaceID
			ws.VmID = ""
			ws.Status = "starting"
			return ws, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			ws := sampleDBWorkspace(arg.ID)
			ws.IsFork = true
			ws.VmID = arg.VmID
			ws.Status = arg.Status
			return ws, nil
		},
	}

	var created, forked atomic.Bool
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			created.Store(true)
			return sandbox.CreateResult{ID: "vm-fresh"}, nil
		},
		forkVMFn: func(ctx context.Context, sourceVMID string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
			forked.Store(true)
			t.Fatalf("ForkSandbox must not be called when the source was never provisioned")
			return sandbox.CreateResult{}, nil
		},
	}))

	ws, err := svc.ForkWorkspace(context.Background(), ForkWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		WorkspaceID:  sourceID,
		Name:         "pair-cold-fork",
	})
	require.NoError(t, err, "an empty source must provision fresh, not 409")
	assert.True(t, created.Load(), "a fresh VM must be created for an empty-source fork")
	assert.False(t, forked.Load(), "ForkSandbox must not run for an empty source")
	assert.Equal(t, "vm-fresh", ws.VMID)
	assert.True(t, ws.IsFork, "lineage is preserved even on the provision-on-empty path")
}

// TestForkWorkspace_ForkFailureFallsBackToFreshVM proves the fork-is-an-
// optimization contract on the pair path: when ForkSandbox fails (slow
// snapshot import, wedged controller request), ForkWorkspace binds a FRESH
// VM to the fork workspace instead of failing the session create.
func TestForkWorkspace_ForkFailureFallsBackToFreshVM(t *testing.T) {
	t.Parallel()

	const sourceID = "ws-fork-src"
	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			ws := sampleDBWorkspace(sourceID)
			ws.Status = "running"
			return ws, nil
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			ws := sampleDBWorkspace("ws-fork")
			ws.IsFork = true
			ws.ParentWorkspaceID = arg.ParentWorkspaceID
			ws.VmID = ""
			ws.Status = "starting"
			return ws, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			ws := sampleDBWorkspace(arg.ID)
			ws.IsFork = true
			ws.VmID = arg.VmID
			ws.Status = arg.Status
			return ws, nil
		},
	}

	var forkTried, created atomic.Bool
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
		},
		forkVMFn: func(ctx context.Context, sourceVMID string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
			forkTried.Store(true)
			return sandbox.CreateResult{}, context.DeadlineExceeded
		},
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			created.Store(true)
			return sandbox.CreateResult{ID: "vm-fresh-fallback"}, nil
		},
	}))

	ws, err := svc.ForkWorkspace(context.Background(), ForkWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		WorkspaceID:  sourceID,
		Name:         "pair-fork-fallback",
	})
	require.NoError(t, err, "a failed fork must fall back, not fail the session")
	assert.True(t, forkTried.Load(), "ForkSandbox must be attempted first")
	assert.True(t, created.Load(), "a fresh VM must be provisioned after the fork failure")
	assert.Equal(t, "vm-fresh-fallback", ws.VMID)
	assert.True(t, ws.IsFork)
}
