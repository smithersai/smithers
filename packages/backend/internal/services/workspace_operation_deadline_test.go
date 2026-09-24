package services

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func assertWorkspaceOperationDeadline(t *testing.T, ctx context.Context, limit time.Duration) {
	t.Helper()
	deadline, ok := ctx.Deadline()
	require.True(t, ok, "every Microsandbox workspace operation must carry a per-call deadline")
	remaining := time.Until(deadline)
	assert.Greater(t, remaining, time.Duration(0))
	assert.LessOrEqual(t, remaining, limit,
		"operation deadline %s exceeds its %s budget and can starve a fallback", remaining, limit)
}

func TestWorkspaceService_MicrosandboxOperationsHavePerCallDeadlines(t *testing.T) {
	t.Parallel()

	t.Run("create bare vm", func(t *testing.T) {
		vm := &mockWorkspaceSandboxVMClient{
			createVMFn: func(ctx context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
				deadline, ok := ctx.Deadline()
				require.True(t, ok)
				remaining := time.Until(deadline)
				assertWorkspaceOperationDeadline(t, ctx, workspaceBareVMCreateAttemptTimeout)
				assert.Greater(t, remaining, workspaceGoldenVMCreateAttemptTimeout,
					"bare image materialization and package install need more than the snapshot budget")
				return sandbox.CreateResult{ID: "vm-created"}, nil
			},
		}
		svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm))
		_, err := svc.createFreshWorkspaceVM(context.Background(), 101, "", 0, "container")
		require.NoError(t, err)
	})

	t.Run("create golden vm", func(t *testing.T) {
		vm := &mockWorkspaceSandboxVMClient{
			createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
				assert.Equal(t, "snapshot-ready", req.SnapshotID)
				assertWorkspaceOperationDeadline(t, ctx, workspaceGoldenVMCreateAttemptTimeout)
				return sandbox.CreateResult{ID: "vm-created"}, nil
			},
		}
		svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm))
		_, err := svc.createWorkspaceVMAttempt(context.Background(), sandbox.CreateRequest{SnapshotID: "snapshot-ready"})
		require.NoError(t, err)
	})

	t.Run("shorter parent deadline wins", func(t *testing.T) {
		parentCtx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		vm := &mockWorkspaceSandboxVMClient{
			createVMFn: func(ctx context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
				assertWorkspaceOperationDeadline(t, ctx, time.Minute)
				return sandbox.CreateResult{ID: "vm-created"}, nil
			},
		}
		svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm))
		_, err := svc.createWorkspaceVMAttempt(parentCtx, sandbox.CreateRequest{})
		require.NoError(t, err)
	})

	t.Run("fallback phases fit the provision budget", func(t *testing.T) {
		const settlementHeadroom = 30 * time.Second
		assert.LessOrEqual(t,
			workspaceGoldenVMCreateAttemptTimeout+workspaceBareVMCreateAttemptTimeout+workspaceCloneTimeout+settlementHeadroom,
			workspaceProvisionTimeout,
			"golden failure, bare fallback, clone, and settlement must fit the outer deadline",
		)
	})

	t.Run("fork vm", func(t *testing.T) {
		vm := &mockWorkspaceSandboxVMClient{
			forkVMFn: func(ctx context.Context, _ string, _ sandbox.ForkRequest) (sandbox.CreateResult, error) {
				assertWorkspaceOperationDeadline(t, ctx, workspaceForkTimeout)
				return sandbox.CreateResult{ID: "vm-forked"}, nil
			},
		}
		svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm))
		_, err := svc.forkWorkspaceSandbox(context.Background(), "vm-source", "container", nil, nil)
		require.NoError(t, err)
	})

	t.Run("fork bookmark switch", func(t *testing.T) {
		vm := &mockWorkspaceSandboxVMClient{
			execAwaitFn: func(ctx context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
				assertWorkspaceOperationDeadline(t, ctx, workspaceForkSwitchTimeout)
				require.NotNil(t, req.TimeoutMS)
				assert.EqualValues(t, 120_000, *req.TimeoutMS)
				zero := int32(0)
				return sandbox.ExecResult{StatusCode: &zero}, nil
			},
		}
		svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm))
		err := svc.switchForkedWorkspaceBookmark(context.Background(), "vm-forked", forkOpenInput("landing/demo/main"))
		require.NoError(t, err)
	})

	t.Run("repository clone", func(t *testing.T) {
		vm := &mockWorkspaceSandboxVMClient{
			execAwaitFn: func(ctx context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
				assertWorkspaceOperationDeadline(t, ctx, workspaceCloneTimeout)
				require.NotNil(t, req.TimeoutMS)
				assert.EqualValues(t, 180_000, *req.TimeoutMS)
				zero := int32(0)
				return sandbox.ExecResult{StatusCode: &zero}, nil
			},
		}
		svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm))
		err := svc.cloneWorkspaceRepository(context.Background(), "vm-created", "https://api.jjhub.tech/alice/demo.git", "token", "main", 0)
		require.NoError(t, err)
	})
}
