package services

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Sync allows up to 1000 workflow files; invoke must find a flow past the
// first listing batch.
func TestInvokeWorkflowFindsDefinitionPastFirstBatch(t *testing.T) {
	all := make([]db.WorkflowDefinition, 0, 450)
	for i := range 450 {
		all = append(all, invokeTestDefinition(int64(i+1), fmt.Sprintf("flow-%03d", i), fmt.Sprintf(".smithers/workflows/flow-%03d.tsx", i), true))
	}
	var captured db.CreateWorkflowRunParams
	querier := &mockWorkflowAPIQuerier{
		listDefsByRepoFn: func(_ context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			start := min(int(arg.PageOffset), len(all))
			end := min(start+int(arg.PageSize), len(all))
			return all[start:end], nil
		},
		createWorkflowRunFn: func(_ context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
			captured = arg
			return db.WorkflowRun{ID: 1, WorkflowDefinitionID: arg.WorkflowDefinitionID}, nil
		},
	}
	result, err := NewWorkflowAPIService(querier, nil).InvokeWorkflow(context.Background(), InvokeWorkflowInput{RepositoryID: 7, Identifier: "flow-440"})
	require.NoError(t, err)
	assert.Equal(t, int64(441), result.Definition.ID)
	assert.Equal(t, int64(441), captured.WorkflowDefinitionID)
}
