package services

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func refusedWorkspaceSandbox() *sandbox.StatusError {
	return &sandbox.StatusError{
		StatusCode: http.StatusServiceUnavailable,
		ErrorCode:  "egress_proxy_unavailable",
		Code:       "egress_proxy_unavailable",
		Message:    "workspace egress proxy is unavailable",
	}
}

func pendingWorkspaceForFailure(id string) db.Workspace {
	workspace := sampleDBWorkspace(id)
	workspace.Status = "starting"
	workspace.VmID = ""
	return workspace
}

func TestWorkspaceServiceRefusedSandboxPersistsFailureAndMapsSyncCode(t *testing.T) {
	workspace := pendingWorkspaceForFailure("ws-refused")
	var persisted db.FailProvisioningWorkspaceIfCurrentParams
	q := &conditionalFailureWorkspaceQuerier{
		mockWorkspaceQuerier: &mockWorkspaceQuerier{
			createWorkspaceFn: func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
				return workspace, nil
			},
		},
		failProvisioningFn: func(_ context.Context, arg db.FailProvisioningWorkspaceIfCurrentParams) (db.Workspace, error) {
			persisted = arg
			failed := workspace
			failed.Status = "failed"
			return failed, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{}, refusedWorkspaceSandbox()
		},
	}))

	_, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		Name:         "refused",
	})
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusInternalServerError, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeEgressProxyUnavailable, apiErr.Code)
	assert.Equal(t, "egress_proxy_unavailable", persisted.FailureCode)
	assert.Equal(t, "workspace egress proxy is unavailable", persisted.FailureMessage)
}

func TestWorkspaceServiceAsyncRefusalPublishesFailureDetails(t *testing.T) {
	workspace := pendingWorkspaceForFailure("ws-async-refused")
	persisted := make(chan db.FailProvisioningWorkspaceIfCurrentParams, 1)
	notified := make(chan db.NotifyWorkspaceStatusParams, 1)
	var failureCalls atomic.Int32
	q := &conditionalFailureWorkspaceQuerier{
		mockWorkspaceQuerier: &mockWorkspaceQuerier{
			createWorkspaceFn: func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
				return workspace, nil
			},
			notifyWorkspaceStatusFn: func(_ context.Context, arg db.NotifyWorkspaceStatusParams) error {
				select {
				case notified <- arg:
				default:
				}
				return nil
			},
		},
		failProvisioningFn: func(_ context.Context, arg db.FailProvisioningWorkspaceIfCurrentParams) (db.Workspace, error) {
			if failureCalls.Add(1) > 1 {
				return db.Workspace{}, pgx.ErrNoRows
			}
			persisted <- arg
			failed := workspace
			failed.Status = "failed"
			return failed, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{}, refusedWorkspaceSandbox()
		},
	}))

	response, err := svc.CreateWorkspaceAsync(context.Background(), CreateWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		Name:         "refused",
	})
	require.NoError(t, err)
	assert.Equal(t, workspace.ID, response.ID)

	select {
	case failure := <-persisted:
		assert.Equal(t, "egress_proxy_unavailable", failure.FailureCode)
		assert.Equal(t, "workspace egress proxy is unavailable", failure.FailureMessage)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for failed workspace persistence")
	}

	select {
	case notification := <-notified:
		var payload map[string]string
		require.NoError(t, json.Unmarshal([]byte(notification.Payload), &payload))
		assert.Equal(t, "failed", payload["status"])
		assert.Equal(t, "egress_proxy_unavailable", payload["failure_code"])
		assert.Equal(t, "workspace egress proxy is unavailable", payload["failure_message"])
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for failed workspace notification")
	}
}

func TestWorkspaceFailureDetailsAcceptsControllerCodes(t *testing.T) {
	for _, code := range []pkgerrors.Code{
		pkgerrors.CodeEgressProxyUnavailable,
		pkgerrors.CodeSecretDeliveryUnavailable,
		pkgerrors.CodeStaleGeneration,
		pkgerrors.CodeQuiesceFailed,
	} {
		details := workspaceFailureDetailsFor(&sandbox.StatusError{Code: string(code), Message: " refused "})
		assert.Equal(t, code, details.Code)
		assert.Equal(t, "refused", details.Message)
	}

	details := workspaceFailureDetailsFor(assert.AnError)
	assert.Equal(t, workspaceProvisioningFailureCode, details.Code)
	assert.Equal(t, assert.AnError.Error(), details.Message)
}
