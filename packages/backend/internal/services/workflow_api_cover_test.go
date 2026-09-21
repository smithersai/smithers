package services

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type workflowAPICovRunner struct {
	rerunFn  func(ctx context.Context, input RerunInput) (*WorkflowRunResult, error)
	resumeFn func(ctx context.Context, repositoryID, runID int64) error
}

func (r *workflowAPICovRunner) DispatchForEvent(context.Context, DispatchForEventInput) ([]WorkflowRunResult, error) {
	return nil, nil
}

func (r *workflowAPICovRunner) CancelRun(context.Context, int64, int64) error {
	return nil
}

func (r *workflowAPICovRunner) RerunRun(ctx context.Context, input RerunInput) (*WorkflowRunResult, error) {
	if r.rerunFn != nil {
		return r.rerunFn(ctx, input)
	}
	return &WorkflowRunResult{WorkflowRunID: 1}, nil
}

func (r *workflowAPICovRunner) ResumeRun(ctx context.Context, repositoryID, runID int64) error {
	if r.resumeFn != nil {
		return r.resumeFn(ctx, repositoryID, runID)
	}
	return nil
}

func TestWorkflowAPI_Cov_RerunResumeAndPaginationBranches(t *testing.T) {
	svc := NewWorkflowAPIService(&mockWorkflowAPIQuerier{}, nil)
	_, err := svc.RerunRun(context.Background(), RerunInput{RepositoryID: 1, RunID: 2})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, workflowAPICovStatus(t, err))

	err = svc.ResumeRun(context.Background(), 1, 2)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, workflowAPICovStatus(t, err))

	var capturedRerun RerunInput
	var capturedResumeRepo, capturedResumeRun int64
	runner := &workflowAPICovRunner{
		rerunFn: func(ctx context.Context, input RerunInput) (*WorkflowRunResult, error) {
			capturedRerun = input
			return &WorkflowRunResult{WorkflowRunID: 55}, nil
		},
		resumeFn: func(ctx context.Context, repositoryID, runID int64) error {
			capturedResumeRepo = repositoryID
			capturedResumeRun = runID
			return nil
		},
	}
	svc = NewWorkflowAPIService(&mockWorkflowAPIQuerier{}, runner)
	result, err := svc.RerunRun(context.Background(), RerunInput{RepositoryID: 10, RunID: 20})
	require.NoError(t, err)
	assert.Equal(t, int64(55), result.WorkflowRunID)
	assert.Equal(t, int64(10), capturedRerun.RepositoryID)
	assert.Equal(t, int64(20), capturedRerun.RunID)

	require.NoError(t, svc.ResumeRun(context.Background(), 10, 20))
	assert.Equal(t, int64(10), capturedResumeRepo)
	assert.Equal(t, int64(20), capturedResumeRun)

	var listArg db.ListWorkflowRunsByDefinitionParams
	svc = NewWorkflowAPIService(&mockWorkflowAPIQuerier{
		listRunsByDefFn: func(ctx context.Context, arg db.ListWorkflowRunsByDefinitionParams) ([]db.WorkflowRun, error) {
			listArg = arg
			return nil, nil
		},
	}, runner)
	_, err = svc.ListWorkflowRunsByDefinition(context.Background(), 1, 2, -4, 0)
	require.NoError(t, err)
	assert.Equal(t, int32(0), listArg.PageOffset)
	assert.Equal(t, int32(30), listArg.PageSize)
}

func TestWorkflowAPI_Cov_ValidateDispatchInputsBranches(t *testing.T) {
	_, err := ValidateDispatchInputs(json.RawMessage(`{"on":`), nil)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, workflowAPICovStatus(t, err))

	_, err = ValidateDispatchInputs(json.RawMessage(`{}`), map[string]interface{}{"x": "y"})
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, workflowAPICovStatus(t, err))

	merged, err := ValidateDispatchInputs(json.RawMessage(`{"on":{"workflow_dispatch":{"inputs":{"weird":"not-object","flag":{"default":true}}}}}`), map[string]interface{}{})
	require.NoError(t, err)
	assert.Equal(t, true, merged["flag"])
	_, hasWeird := merged["weird"]
	assert.False(t, hasWeird)
}

func workflowAPICovStatus(t *testing.T, err error) int {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	return apiErr.Status
}
