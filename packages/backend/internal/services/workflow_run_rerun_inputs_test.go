package services

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A rerun must reproduce the original inputs or refuse; silently rerunning
// with no inputs behaves differently from the original run.
func TestWorkflowRunService_RerunRun_RefusesUnreadableDispatchInputs(t *testing.T) {
	t.Parallel()
	for _, stored := range []string{`[1,2]`, `"text"`, `{not-json`} {
		t.Run(stored, func(t *testing.T) {
			mock := &mockWorkflowRunQuerier{
				getRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
					return db.WorkflowRun{ID: 1, RepositoryID: 42, WorkflowDefinitionID: 10, TriggerEvent: "invoke", TriggerRef: "main", DispatchInputs: []byte(stored), CreatedAt: time.Now(), UpdatedAt: time.Now()}, nil
				},
				getDefFn: func(context.Context, db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
					return makeWorkflowDef(10, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`), nil
				},
			}
			_, err := NewWorkflowRunService(mock).RerunRun(context.Background(), RerunInput{RepositoryID: 42, RunID: 1, UserID: 1})
			require.Error(t, err)
			assert.Equal(t, 409, apiStatus(t, err))
			assert.Empty(t, mock.createRunCalls)
		})
	}
}
