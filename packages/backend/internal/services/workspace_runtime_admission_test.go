package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type admissionWorkspaceRuntime struct {
	workspaceapi.WorkspaceRuntime
	starts   int
	startErr error
}

func (r *admissionWorkspaceRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceStopped}, nil
}
func (r *admissionWorkspaceRuntime) StartWorkspace(context.Context, string) (workspaceapi.Workspace, error) {
	r.starts++
	return workspaceapi.Workspace{}, r.startErr
}

func TestWorkspaceRuntimeResumeUsesCommonAdmission(t *testing.T) {
	denied := errors.New("new sandbox slot denied")
	startFailed := errors.New("runtime start reached")
	for _, status := range []string{"running", "suspended"} {
		t.Run(status, func(t *testing.T) {
			policy := &countedResumePolicy{startErr: denied}
			runtime := &admissionWorkspaceRuntime{startErr: startFailed}
			row := sampleDBWorkspace("ws-runtime-admission")
			row.Status = status
			row.VmID = "vm-counted"
			service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceBillingPolicy(policy), WithWorkspaceRuntime(runtime))
			_, err := service.ensureRuntimeWorkspaceRunningLocked(context.Background(), row, row.UserID)
			if status == "running" {
				require.ErrorContains(t, err, startFailed.Error())
				require.Equal(t, 1, runtime.starts)
				require.Equal(t, 1, policy.countedCalls)
			} else {
				require.ErrorIs(t, err, denied)
				require.Zero(t, runtime.starts)
				require.Zero(t, policy.countedCalls)
			}
		})
	}
}
