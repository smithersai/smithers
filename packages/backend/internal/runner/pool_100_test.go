package runner

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestPool_H_ClaimTaskReleasesRunnerWhenMarkRunningFails(t *testing.T) {
	t.Parallel()

	markErr := errors.New("mark running failed")
	calls := make([]string, 0, 4)
	store := &mockStore{
		claimIdleRunnerFn: func(_ context.Context, runnerID int64) (db.RunnerPool, error) {
			calls = append(calls, "claim-idle")
			assert.Equal(t, int64(77), runnerID)
			return db.RunnerPool{ID: runnerID, Status: "busy"}, nil
		},
		claimPendingTaskFn: func(_ context.Context, runnerID pgtype.Int8) (db.WorkflowTask, error) {
			calls = append(calls, "claim-task")
			assert.Equal(t, int64(77), runnerID.Int64)
			assert.True(t, runnerID.Valid)
			return db.WorkflowTask{ID: 88, Status: "assigned", RunnerID: runnerID}, nil
		},
		markTaskRunningFn: func(_ context.Context, arg db.MarkWorkflowTaskRunningParams) (int64, error) {
			calls = append(calls, "mark-running")
			assert.Equal(t, int64(88), arg.ID)
			assert.Equal(t, int64(77), arg.RunnerID.Int64)
			assert.True(t, arg.RunnerID.Valid)
			return 0, markErr
		},
		releaseRunnerFn: func(_ context.Context, runnerID int64) (int64, error) {
			calls = append(calls, "release-runner")
			assert.Equal(t, int64(77), runnerID)
			return 1, nil
		},
	}

	pool := NewRunnerPool(store, Config{})
	task, err := pool.ClaimTask(context.Background(), 77)

	require.ErrorIs(t, err, markErr)
	assert.Nil(t, task)
	assert.Equal(t, []string{"claim-idle", "claim-task", "mark-running", "release-runner"}, calls)
	assert.Equal(t, 1, store.ReleaseCallCount())
}
