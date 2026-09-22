package runner

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestPool_Cov_PublicWrappersDelegate(t *testing.T) {
	t.Parallel()

	store := &mockStore{
		upsertRunnerFn: func(_ context.Context, arg clusterdb.UpsertRunnerParams) (clusterdb.RunnerPool, error) {
			assert.Equal(t, "runner-public", arg.Name)
			assert.JSONEq(t, `{"arch":"arm64"}`, string(arg.Metadata))
			return clusterdb.RunnerPool{ID: 101, Name: arg.Name, Status: "idle", Metadata: arg.Metadata}, nil
		},
		claimIdleRunnerFn: func(_ context.Context, runnerID int64) (clusterdb.RunnerPool, error) {
			assert.Positive(t, runnerID)
			return clusterdb.RunnerPool{ID: runnerID, Status: "busy"}, nil
		},
		claimPendingTaskFn: func(_ context.Context, runnerID pgtype.Int8) (db.WorkflowTask, error) {
			assert.True(t, runnerID.Valid)
			return db.WorkflowTask{ID: 202, Status: "assigned", RunnerID: runnerID}, nil
		},
		markTaskRunningFn: func(_ context.Context, arg db.MarkWorkflowTaskRunningParams) (int64, error) {
			assert.Equal(t, int64(202), arg.ID)
			assert.Equal(t, int64(101), arg.RunnerID.Int64)
			return 1, nil
		},
		markTaskDoneFn: func(_ context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error) {
			assert.Equal(t, int64(202), arg.ID)
			assert.Equal(t, int64(101), arg.RunnerID.Int64)
			assert.Contains(t, []string{"failed", "done"}, arg.Status)
			return 1, nil
		},
		releaseRunnerFn: func(_ context.Context, runnerID int64) (int64, error) {
			assert.Equal(t, int64(101), runnerID)
			return 1, nil
		},
		terminateRunnerFn: func(_ context.Context, runnerID int64) (clusterdb.RunnerPool, error) {
			assert.Contains(t, []int64{101, 303}, runnerID)
			return clusterdb.RunnerPool{ID: runnerID, Status: "offline"}, nil
		},
		requeueTasksForRunner: func(_ context.Context, runnerID pgtype.Int8) (int64, error) {
			assert.True(t, runnerID.Valid)
			assert.Contains(t, []int64{101, 303}, runnerID.Int64)
			return 2, nil
		},
		listStaleRunnersFn: func(context.Context, pgtype.Timestamptz) ([]clusterdb.RunnerPool, error) {
			return []clusterdb.RunnerPool{{ID: 303, Status: "busy"}}, nil
		},
	}

	pool := NewRunnerPool(store, Config{})
	ctx := context.Background()

	registered, err := pool.RegisterRunner(ctx, RegisterRunnerInput{
		Name:     "runner-public",
		Metadata: json.RawMessage(`{"arch":"arm64"}`),
	})
	require.NoError(t, err)
	assert.Equal(t, int64(101), registered.ID)

	claimed, err := pool.ClaimRunner(ctx, registered.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(202), claimed.ID)

	require.NoError(t, pool.MarkTaskRunning(ctx, claimed.ID, registered.ID))
	require.NoError(t, pool.MarkTaskDone(ctx, claimed.ID, registered.ID, "failed", "boom"))
	require.NoError(t, pool.ReleaseRunner(ctx, registered.ID))
	require.NoError(t, pool.TerminateRunner(ctx, registered.ID))

	task, err := pool.ClaimTask(ctx, registered.ID)
	require.NoError(t, err)
	require.NotNil(t, task)
	assert.Equal(t, int64(202), task.ID)

	cleaned, err := pool.CleanupStaleRunners(ctx)
	require.NoError(t, err)
	assert.Equal(t, 1, cleaned)
}

func TestPool_Cov_ClaimTaskReturnsNilOnClaimError(t *testing.T) {
	t.Parallel()

	claimErr := errors.New("runner busy")
	store := &mockStore{
		claimIdleRunnerFn: func(context.Context, int64) (clusterdb.RunnerPool, error) {
			return clusterdb.RunnerPool{}, claimErr
		},
	}

	pool := NewRunnerPool(store, Config{})
	task, err := pool.ClaimTask(context.Background(), 101)
	require.ErrorIs(t, err, claimErr)
	assert.Nil(t, task)
}

func TestPool_Cov_CompleteTaskReturnsMarkError(t *testing.T) {
	t.Parallel()

	markErr := errors.New("mark failed")
	releaseCalled := false
	store := &mockStore{
		markTaskDoneFn: func(context.Context, db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 0, markErr
		},
		releaseRunnerFn: func(context.Context, int64) (int64, error) {
			releaseCalled = true
			return 1, nil
		},
	}

	pool := NewRunnerPool(store, Config{})
	err := pool.CompleteTask(context.Background(), 202, 101, "done", "")
	require.ErrorIs(t, err, markErr)
	assert.False(t, releaseCalled)
}
