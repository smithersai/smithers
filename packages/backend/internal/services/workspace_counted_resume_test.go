package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type countedResumePolicy struct {
	sandboxPolicyStub
	countedCalls int
	startErr     error
}

type countedResumeStore struct {
	*mockWorkspaceQuerier
	workspace db.Workspace
}

func (s *countedResumeStore) SetWorkspaceIdleTimeout(_ context.Context, arg db.SetWorkspaceIdleTimeoutParams) (db.Workspace, error) {
	s.workspace.IdleTimeoutSecs = arg.IdleTimeoutSecs
	return s.workspace, nil
}

func (p *countedResumePolicy) AuthorizeSandboxStart(context.Context, int64) error { return p.startErr }

func (p *countedResumePolicy) AuthorizeCountedSandboxResume(context.Context, int64, string, string) error {
	p.countedCalls++
	return nil
}

func TestWorkspaceIdleSleptCountedResumeUsesExistingSlot(t *testing.T) {
	denied := errors.New("new sandbox slot denied")
	startFailed := errors.New("provider start reached")
	for _, status := range []string{"running", "suspended"} {
		t.Run(status, func(t *testing.T) {
			policy := &countedResumePolicy{sandboxPolicyStub: sandboxPolicyStub{entitlement: SandboxEntitlement{IdleTimeoutSecs: 60, HoursPerDay: -1}}, startErr: denied}
			starts := 0
			workspace := sampleDBWorkspace("ws-counted")
			workspace.Status = status
			workspace.VmID = "vm-counted"
			svc := newWorkspaceServiceForTests(&countedResumeStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{}, workspace: workspace},
				WithWorkspaceBillingPolicy(policy),
				WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
					getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
						return sandbox.Sandbox{ID: workspace.VmID, State: sandbox.StateStopped}, nil
					},
					startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
						starts++
						return sandbox.StartResult{}, startFailed
					},
				}))
			_, err := svc.ensureExistingWorkspaceRunning(context.Background(), workspace)
			if status == "running" {
				require.Error(t, err)
				assert.ErrorContains(t, err, startFailed.Error())
				assert.Equal(t, 1, starts)
				assert.Equal(t, 1, policy.countedCalls)
			} else {
				require.ErrorContains(t, err, denied.Error())
				assert.Zero(t, starts)
				assert.Zero(t, policy.countedCalls)
			}
		})
	}
}
