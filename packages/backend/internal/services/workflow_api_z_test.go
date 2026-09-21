package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestWorkflowAPI_Z_PaginationOffsetsAndEmptyConfigInputs(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	q := &workflowAPIZQuerier{}
	svc := NewWorkflowAPIService(q, nil)

	_, err := svc.ListWorkflowDefinitions(ctx, 10, -5, 0)
	require.NoError(t, err)
	assert.Equal(t, int32(0), q.defsArg.PageOffset)
	assert.Equal(t, int32(listWorkflowDefinitionsBatchSize), q.defsArg.PageSize)

	_, err = svc.ListWorkflowRunsByRepo(ctx, 10, -5, 0)
	require.NoError(t, err)
	assert.Equal(t, int32(0), q.runsArg.PageOffset)
	assert.Equal(t, int32(30), q.runsArg.PageSize)

	_, err = ValidateDispatchInputs(nil, map[string]interface{}{"env": "prod"})
	assert.Equal(t, 400, apiStatus(t, err))
}

type workflowAPIZQuerier struct {
	defsArg db.ListWorkflowDefinitionsByRepoParams
	runsArg db.ListWorkflowRunsByRepoParams
}

func (q *workflowAPIZQuerier) ListWorkflowDefinitionsByRepo(_ context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
	q.defsArg = arg
	return nil, nil
}

func (q *workflowAPIZQuerier) GetWorkflowDefinition(context.Context, db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
	return db.WorkflowDefinition{}, nil
}

func (q *workflowAPIZQuerier) ListWorkflowRunsByRepo(_ context.Context, arg db.ListWorkflowRunsByRepoParams) ([]db.WorkflowRun, error) {
	q.runsArg = arg
	return nil, nil
}

func (q *workflowAPIZQuerier) ListWorkflowRunsByDefinition(context.Context, db.ListWorkflowRunsByDefinitionParams) ([]db.WorkflowRun, error) {
	return nil, nil
}

func (q *workflowAPIZQuerier) GetWorkflowRun(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
	return db.WorkflowRun{}, nil
}

func (q *workflowAPIZQuerier) CreateWorkflowRun(context.Context, db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
	return db.WorkflowRun{}, nil
}

func (q *workflowAPIZQuerier) ListWorkflowStepsByRunID(context.Context, int64) ([]db.WorkflowStep, error) {
	return nil, nil
}

func (q *workflowAPIZQuerier) ListWorkflowLogsSince(context.Context, db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error) {
	return nil, nil
}
