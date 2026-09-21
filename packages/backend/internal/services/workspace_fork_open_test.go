package services

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	sandbox "github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// derivedWorkspace is a new branch workspace row: IsFork=true, no VM yet.
func derivedWorkspace(id, bookmark string) db.Workspace {
	w := sampleDBWorkspace(id)
	w.IsFork = true
	w.TargetBookmark = bookmark
	w.VmID = ""
	w.Status = "starting"
	return w
}

func forkOpenInput(bookmark string) CreateWorkspaceSessionInput {
	return CreateWorkspaceSessionInput{
		RepositoryID:   101,
		UserID:         1,
		RepoOwner:      "alice",
		RepoName:       "demo",
		SourceBookmark: bookmark,
	}
}

// A derived workspace with a forkable primary is provisioned by FORKING the
// primary VM and switching the fork onto the target bookmark — no cold VM
// create, no full re-clone.
func TestWorkspaceService_CreateWorkspaceVM_ForksDerivedFromPrimary(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getActiveWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			primary := sampleDBWorkspace("ws-primary")
			primary.VmID = "vm-primary"
			primary.Status = "running"
			return primary, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			w := sampleDBWorkspace(arg.ID)
			w.IsFork = true
			w.VmID = arg.VmID
			w.Status = arg.Status
			return w, nil
		},
	}

	var (
		forkedFrom  string
		switchCmd   string
		coldCreated bool
	)
	vm := &mockWorkspaceSandboxVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
		},
		forkVMFn: func(ctx context.Context, sourceVMID string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
			forkedFrom = sourceVMID
			return sandbox.CreateResult{ID: "vm-fork"}, nil
		},
		execAwaitFn: func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			switchCmd = req.Command
			zero := int32(0)
			return sandbox.ExecResult{StatusCode: &zero}, nil
		},
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			coldCreated = true
			return sandbox.CreateResult{ID: "vm-cold"}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(vm))

	got, err := svc.createWorkspaceVM(context.Background(), derivedWorkspace("ws-branch", "landing/demo/main"), forkOpenInput("landing/demo/main"))
	require.NoError(t, err)
	assert.Equal(t, "vm-fork", got.VmID, "the branch must run on the FORKED vm")
	assert.Equal(t, "running", got.Status)
	assert.Equal(t, "vm-primary", forkedFrom, "it forks the primary workspace VM")
	assert.False(t, coldCreated, "no cold VM create when the fork path succeeds")
	assert.Contains(t, switchCmd, "landing/demo/main@origin", "the switch fetches + tracks the target bookmark")
	assert.Contains(t, switchCmd, "git", "the switch does a delta fetch, not a re-clone")
	assert.NotContains(t, switchCmd, "clone", "the fork must NOT re-clone the repo")
}

// No primary workspace to fork → the cold create+clone path runs unchanged.
func TestWorkspaceService_CreateWorkspaceVM_ColdWhenNoPrimary(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getActiveWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			w := sampleDBWorkspace(arg.ID)
			w.IsFork = true
			w.VmID = arg.VmID
			w.Status = arg.Status
			return w, nil
		},
	}
	var forkCalled bool
	vm := &mockWorkspaceSandboxVMClient{
		forkVMFn: func(ctx context.Context, sourceVMID string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
			forkCalled = true
			return sandbox.CreateResult{ID: "vm-fork"}, nil
		},
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-cold"}, nil
		},
		execAwaitFn: func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			zero := int32(0)
			return sandbox.ExecResult{StatusCode: &zero}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(vm))

	got, err := svc.createWorkspaceVM(context.Background(), derivedWorkspace("ws-branch", "landing/demo/main"), forkOpenInput("landing/demo/main"))
	require.NoError(t, err)
	assert.False(t, forkCalled, "with no primary, there is nothing to fork")
	assert.Equal(t, "vm-cold", got.VmID, "the cold create+clone path runs")
}

// A stuck fork used to inherit the full 10-minute provisioning context. When
// it finally returned deadline exceeded, the cold fallback inherited that
// already-dead context and failed before CreateVM. The fork now has a child
// deadline: its failure (including an ambiguous partial id) is cleaned up while
// the parent remains usable for cold provisioning.
func TestWorkspaceService_CreateWorkspaceVM_ForkTimeoutLeavesColdFallbackUsable(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getActiveWorkspaceForUserRepoFn: func(context.Context, db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			primary := sampleDBWorkspace("ws-primary")
			primary.VmID = "vm-primary"
			primary.Status = "running"
			return primary, nil
		},
		updateWorkspaceExecutionInfoFn: func(_ context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			w := derivedWorkspace(arg.ID, "landing/demo/main")
			w.VmID = arg.VmID
			w.Status = arg.Status
			return w, nil
		},
	}

	var (
		deletedFork string
		coldCtxErr  error
	)
	vm := &mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{State: sandbox.StateRunning}, nil
		},
		forkVMFn: func(ctx context.Context, _ string, _ sandbox.ForkRequest) (sandbox.CreateResult, error) {
			assertWorkspaceOperationDeadline(t, ctx, workspaceForkTimeout)
			return sandbox.CreateResult{ID: "vm-partial-fork"}, context.DeadlineExceeded
		},
		deleteVMFn: func(_ context.Context, vmID string) error {
			if vmID == "vm-partial-fork" {
				deletedFork = vmID
			}
			return nil
		},
		createVMFn: func(ctx context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
			coldCtxErr = ctx.Err()
			return sandbox.CreateResult{ID: "vm-cold"}, nil
		},
		execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			zero := int32(0)
			return sandbox.ExecResult{StatusCode: &zero}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(vm))

	got, err := svc.createWorkspaceVM(context.Background(), derivedWorkspace("ws-branch", "landing/demo/main"), forkOpenInput("landing/demo/main"))
	require.NoError(t, err)
	assert.NoError(t, coldCtxErr, "the fork's child deadline must not cancel the cold fallback's parent context")
	assert.Equal(t, "vm-partial-fork", deletedFork, "an errored fork with a known id must be reaped")
	assert.Equal(t, "vm-cold", got.VmID)
}

// A fork whose bookmark switch fails deletes the fork and falls back to cold —
// never leaving the user on the wrong branch.
func TestWorkspaceService_CreateWorkspaceVM_ColdWhenForkSwitchFails(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getActiveWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			primary := sampleDBWorkspace("ws-primary")
			primary.VmID = "vm-primary"
			primary.Status = "running"
			return primary, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			w := sampleDBWorkspace(arg.ID)
			w.IsFork = true
			w.VmID = arg.VmID
			w.Status = arg.Status
			return w, nil
		},
	}
	var deletedForkVM string
	vm := &mockWorkspaceSandboxVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
		},
		forkVMFn: func(ctx context.Context, sourceVMID string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-fork"}, nil
		},
		execAwaitFn: func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			// clone runs on the cold VM (vm-cold); the fork switch (vm-fork) fails.
			if vmID == "vm-fork" {
				bad := int32(1)
				return sandbox.ExecResult{StatusCode: &bad, Stderr: "fetch refused"}, nil
			}
			zero := int32(0)
			return sandbox.ExecResult{StatusCode: &zero}, nil
		},
		deleteVMFn: func(ctx context.Context, vmID string) error {
			if strings.Contains(vmID, "fork") {
				deletedForkVM = vmID
			}
			return nil
		},
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-cold"}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(vm))

	got, err := svc.createWorkspaceVM(context.Background(), derivedWorkspace("ws-branch", "landing/demo/main"), forkOpenInput("landing/demo/main"))
	require.NoError(t, err)
	assert.Equal(t, "vm-fork", deletedForkVM, "a failed-switch fork VM must be deleted, not leaked")
	assert.Equal(t, "vm-cold", got.VmID, "provisioning falls back to the cold path")
}

// If the fork's vm_id register fails BECAUSE the provisioning ctx was
// cancelled (e.g. the async provision deadline lands on that DB write), the
// fork VM — whose id is persisted only by that very write — must STILL be
// deleted, or it leaks with no DB row and no reaper to find it. The cleanup
// must use a cancellation-surviving ctx (deleteOrphanedWorkspaceVM wraps
// context.WithoutCancel), not the dead request ctx.
func TestWorkspaceService_CreateWorkspaceVM_ForkRegisterCancelledStillDeletesVM(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	q := &mockWorkspaceQuerier{
		getActiveWorkspaceForUserRepoFn: func(context.Context, db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			primary := sampleDBWorkspace("ws-primary")
			primary.VmID = "vm-primary"
			primary.Status = "running"
			return primary, nil
		},
		updateWorkspaceExecutionInfoFn: func(context.Context, db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			// Simulate the provision ctx being cancelled at the register step.
			cancel()
			return db.Workspace{}, context.Canceled
		},
	}
	var deleteCtxErr error
	var deletedForkVM string
	vm := &mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{State: sandbox.StateRunning}, nil
		},
		forkVMFn: func(context.Context, string, sandbox.ForkRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-fork"}, nil
		},
		execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			zero := int32(0)
			return sandbox.ExecResult{StatusCode: &zero}, nil
		},
		deleteVMFn: func(delCtx context.Context, vmID string) error {
			if vmID == "vm-fork" {
				deletedForkVM = vmID
				deleteCtxErr = delCtx.Err() // must be nil: the delete survives the cancelled parent
			}
			return nil
		},
		// Cold fallback create — the outer createWorkspaceVM continues after the
		// fork declines; its own clone token issue will fail on the cancelled
		// ctx, but that is the cold path's concern, not the leak we assert here.
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-cold"}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(vm))

	_, _ = svc.createWorkspaceVM(ctx, derivedWorkspace("ws-branch", "landing/demo/main"), forkOpenInput("landing/demo/main"))

	assert.Equal(t, "vm-fork", deletedForkVM, "the fork VM must be deleted even when register fails on a cancelled ctx")
	assert.NoError(t, deleteCtxErr, "the cleanup delete must run on a cancellation-surviving ctx, not the dead request ctx")
}

// The PRIMARY workspace (is_fork=false) never forks — it is the repo's source
// of truth and must clone.
func TestWorkspaceService_CreateWorkspaceVM_PrimaryNeverForks(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getActiveWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			// Even if an active workspace exists, a non-fork primary must not fork.
			w := sampleDBWorkspace("ws-other")
			w.VmID = "vm-other"
			return w, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			w := sampleDBWorkspace(arg.ID)
			w.VmID = arg.VmID
			w.Status = arg.Status
			return w, nil
		},
	}
	var forkCalled bool
	vm := &mockWorkspaceSandboxVMClient{
		forkVMFn: func(ctx context.Context, sourceVMID string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
			forkCalled = true
			return sandbox.CreateResult{ID: "vm-fork"}, nil
		},
		execAwaitFn: func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			zero := int32(0)
			return sandbox.ExecResult{StatusCode: &zero}, nil
		},
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-cold"}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(vm))

	primary := sampleDBWorkspace("ws-primary")
	primary.IsFork = false
	primary.VmID = ""
	primary.Status = "starting"
	got, err := svc.createWorkspaceVM(context.Background(), primary, forkOpenInput("main"))
	require.NoError(t, err)
	assert.False(t, forkCalled, "the primary workspace must clone, never fork")
	assert.Equal(t, "vm-cold", got.VmID)
}
