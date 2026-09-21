package services

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestWorkspaceResumePreservesLostWorkerResponseAndRetainedVM(t *testing.T) {
	workspace := sampleDBWorkspace("ws-retained")
	workspace.VmID = "vm-retained"
	workspace.Status = "suspended"
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{},
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
				return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: http.StatusServiceUnavailable,
					Code: "host_lease_lost", Message: "The workspace worker is unavailable. Use another workspace, or retry when this worker is available."}
			},
		}))
	retained, err := svc.ensureExistingWorkspaceRunning(context.Background(), workspace)
	failure := apiErrorOf(t, err)
	assert.Equal(t, http.StatusServiceUnavailable, failure.Status)
	assert.Equal(t, pkgerrors.CodeHostLeaseLost, failure.Code)
	assert.Equal(t, pkgerrors.FaultInfra, failure.Fault)
	assert.Contains(t, failure.Message, "Use another workspace, or retry when this worker is available.")
	assert.NotContains(t, failure.Message, "create")
	assert.Equal(t, workspace, retained)
}
