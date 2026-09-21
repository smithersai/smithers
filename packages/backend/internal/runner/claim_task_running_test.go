package runner

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// ClaimTask (the executor.TaskPool entry the local-dev direct-DB runner uses) must
// transition the claimed task assigned->running. claimRunner alone leaves it
// 'assigned', and CompleteTask/MarkWorkflowTaskDone require 'running' — so without
// this every local-dev task hangs and CompleteTask fails with no rows.
func TestRunnerPool_ClaimTask_TransitionsTaskToRunning(t *testing.T) {
	t.Parallel()

	var runningTaskID int64
	store := &mockStore{
		claimIdleRunnerFn: func(_ context.Context, runnerID int64) (db.RunnerPool, error) {
			return db.RunnerPool{ID: runnerID, Status: "busy"}, nil
		},
		claimPendingTaskFn: func(_ context.Context, runnerID pgtype.Int8) (db.WorkflowTask, error) {
			return db.WorkflowTask{ID: 42, Status: "assigned", RunnerID: runnerID}, nil
		},
		markTaskRunningFn: func(_ context.Context, arg db.MarkWorkflowTaskRunningParams) (int64, error) {
			runningTaskID = arg.ID
			return 1, nil
		},
	}

	pool := NewRunnerPool(store, Config{})
	task, err := pool.ClaimTask(context.Background(), 7)
	require.NoError(t, err)
	require.NotNil(t, task)
	assert.Equal(t, int64(42), task.ID)
	assert.Equal(t, int64(42), runningTaskID, "ClaimTask must transition the claimed task to running")
}
