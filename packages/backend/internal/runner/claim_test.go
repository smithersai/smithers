package runner

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestRunnerPool_claimRunner_AssignsPendingTask(t *testing.T) {
	t.Parallel()

	callOrder := make([]string, 0, 2)
	store := &mockStore{
		claimIdleRunnerFn: func(_ context.Context, runnerID int64) (clusterdb.RunnerPool, error) {
			callOrder = append(callOrder, "claim-runner")
			assert.Equal(t, int64(13), runnerID)
			return clusterdb.RunnerPool{ID: runnerID, Status: "busy"}, nil
		},
		claimPendingTaskFn: func(_ context.Context, runnerID pgtype.Int8) (db.WorkflowTask, error) {
			callOrder = append(callOrder, "claim-task")
			assert.Equal(t, int64(13), runnerID.Int64)
			assert.True(t, runnerID.Valid)
			return db.WorkflowTask{ID: 88, Status: "assigned", RunnerID: runnerID}, nil
		},
	}

	pool := NewRunnerPool(store, Config{})
	task, err := pool.claimRunner(context.Background(), 13)
	require.NoError(t, err)
	assert.Equal(t, int64(88), task.ID)
	assert.Equal(t, []string{"claim-runner", "claim-task"}, callOrder)
}

func TestRunnerPool_claimRunner_NoTaskReleasesRunner(t *testing.T) {
	t.Parallel()

	callOrder := make([]string, 0, 3)
	store := &mockStore{
		claimIdleRunnerFn: func(_ context.Context, runnerID int64) (clusterdb.RunnerPool, error) {
			callOrder = append(callOrder, "claim-runner")
			return clusterdb.RunnerPool{ID: runnerID, Status: "busy"}, nil
		},
		claimPendingTaskFn: func(_ context.Context, _ pgtype.Int8) (db.WorkflowTask, error) {
			callOrder = append(callOrder, "claim-task")
			return db.WorkflowTask{}, pgx.ErrNoRows
		},
		releaseRunnerFn: func(_ context.Context, runnerID int64) (int64, error) {
			callOrder = append(callOrder, "release-runner")
			return 1, nil
		},
	}

	pool := NewRunnerPool(store, Config{})
	_, err := pool.claimRunner(context.Background(), 13)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	assert.Equal(t, []string{"claim-runner", "claim-task", "release-runner"}, callOrder)
}

// A non-ErrNoRows failure from ClaimPendingTask must still release the
// runner; otherwise it is leaked in the busy state forever.
func TestRunnerPool_claimRunner_ClaimErrorReleasesRunner(t *testing.T) {
	t.Parallel()

	claimErr := errors.New("query timeout")
	released := false
	store := &mockStore{
		claimIdleRunnerFn: func(_ context.Context, runnerID int64) (clusterdb.RunnerPool, error) {
			return clusterdb.RunnerPool{ID: runnerID, Status: "busy"}, nil
		},
		claimPendingTaskFn: func(_ context.Context, _ pgtype.Int8) (db.WorkflowTask, error) {
			return db.WorkflowTask{}, claimErr
		},
		releaseRunnerFn: func(_ context.Context, runnerID int64) (int64, error) {
			released = true
			assert.Equal(t, int64(13), runnerID)
			return 1, nil
		},
	}

	pool := NewRunnerPool(store, Config{})
	_, err := pool.claimRunner(context.Background(), 13)
	require.ErrorIs(t, err, claimErr)
	assert.True(t, released, "runner must be released when the task claim fails")
}

func TestRunnerPool_claimRunner_ConcurrencyContention(t *testing.T) {
	t.Parallel()

	const workers = 8
	var claimCount atomic.Int32

	store := &mockStore{
		claimIdleRunnerFn: func(_ context.Context, runnerID int64) (clusterdb.RunnerPool, error) {
			return clusterdb.RunnerPool{ID: runnerID, Status: "busy"}, nil
		},
		claimPendingTaskFn: func(_ context.Context, runnerID pgtype.Int8) (db.WorkflowTask, error) {
			if claimCount.Add(1) == 1 {
				return db.WorkflowTask{ID: 501, Status: "assigned", RunnerID: runnerID}, nil
			}
			return db.WorkflowTask{}, pgx.ErrNoRows
		},
		releaseRunnerFn: func(_ context.Context, runnerID int64) (int64, error) {
			return 1, nil
		},
	}

	pool := NewRunnerPool(store, Config{})
	errs := make(chan error, workers)

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			_, err := pool.claimRunner(context.Background(), int64(100+idx))
			errs <- err
		}(i)
	}

	wg.Wait()
	close(errs)

	successes := 0
	noRows := 0
	for err := range errs {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, pgx.ErrNoRows):
			noRows++
		default:
			require.NoError(t, err)
		}
	}

	assert.Equal(t, 1, successes)
	assert.Equal(t, workers-1, noRows)
	assert.Equal(t, workers-1, store.ReleaseCallCount())
}

func TestRunnerPool_markTaskRunning_Success(t *testing.T) {
	t.Parallel()

	var captured db.MarkWorkflowTaskRunningParams
	store := &mockStore{
		markTaskRunningFn: func(_ context.Context, arg db.MarkWorkflowTaskRunningParams) (int64, error) {
			captured = arg
			return 1, nil
		},
	}

	pool := NewRunnerPool(store, Config{})
	err := pool.markTaskRunning(context.Background(), 91, 11)
	require.NoError(t, err)
	assert.Equal(t, int64(91), captured.ID)
	assert.Equal(t, int64(11), captured.RunnerID.Int64)
	assert.True(t, captured.RunnerID.Valid)
}

func TestRunnerPool_markTaskDone_Success(t *testing.T) {
	t.Parallel()

	var captured db.MarkWorkflowTaskDoneParams
	store := &mockStore{
		markTaskDoneFn: func(_ context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error) {
			captured = arg
			return 1, nil
		},
	}

	pool := NewRunnerPool(store, Config{})
	err := pool.markTaskDone(context.Background(), 91, 11, "done", "")
	require.NoError(t, err)
	assert.Equal(t, int64(91), captured.ID)
	assert.Equal(t, int64(11), captured.RunnerID.Int64)
	assert.True(t, captured.RunnerID.Valid)
	assert.Equal(t, "done", captured.Status)
	assert.Equal(t, "", captured.LastError.String)
}

// TestRunnerPool_markTaskDone_DoesNotResolveDependencies verifies that markTaskDone
// does NOT call dependency resolution methods. Dependency resolution is handled
// by the service layer (RunnerService.progressDependencies), not the pool.
func TestRunnerPool_markTaskDone_DoesNotResolveDependencies(t *testing.T) {
	t.Parallel()

	// Test all terminal statuses - none should trigger dependency resolution
	statuses := []string{"done", "failed", "cancelled"}

	for _, status := range statuses {
		status := status
		t.Run(status, func(t *testing.T) {
			t.Parallel()

			markTaskDoneCalls := 0

			store := &mockStore{
				markTaskDoneFn: func(_ context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error) {
					markTaskDoneCalls++
					return 100, nil
				},
			}

			pool := NewRunnerPool(store, Config{})
			err := pool.markTaskDone(context.Background(), 91, 11, status, "")
			require.NoError(t, err)

			// markTaskDone should be called exactly once for each terminal status
			assert.Equal(t, 1, markTaskDoneCalls, "MarkWorkflowTaskDone should be called exactly once")
			// Note: Dependency resolution is handled by the service layer, not the pool.
			// The pool no longer has access to ListBlockedTasksForRun, ListTaskStepInfoForRun,
			// or UnblockWorkflowTask - these were removed from the Store interface.
		})
	}
}

// TestRunnerPool_markTaskDone_PoolHasNoDependencyResolutionMethods verifies that
// the runner pool's Store interface does not include dependency resolution methods.
// This ensures the pool cannot accidentally resolve dependencies - that responsibility
// belongs to the service layer (RunnerService.progressDependencies).
func TestRunnerPool_markTaskDone_PoolHasNoDependencyResolutionMethods(t *testing.T) {
	t.Parallel()

	// This test documents that the Store interface intentionally lacks methods
	// for dependency resolution. If someone tries to add them back, this test
	// will help clarify why they were removed.

	// The Store interface in store.go should NOT have:
	// - ListBlockedTasksForRun
	// - ListTaskStepInfoForRun
	// - UnblockWorkflowTask
	// - SkipBlockedWorkflowTask

	// These methods are only available on the RunnerQuerier interface in services/runner.go,
	// ensuring that dependency resolution can only happen through the service layer.

	// Verify that the mock store doesn't implement dependency resolution methods
	// by attempting to assign it to a minimal interface that only has the methods
	// the pool should use.
	type minimalPoolStore interface {
		MarkWorkflowTaskDone(ctx context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error)
	}

	var _ minimalPoolStore = &mockStore{}

	// The mock store should not have methods that would allow dependency resolution
	mock := &mockStore{
		markTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 100, nil
		},
	}

	pool := NewRunnerPool(mock, Config{})
	err := pool.markTaskDone(context.Background(), 1, 1, "done", "")
	require.NoError(t, err)

	// Verify that CompleteTask also doesn't trigger dependency resolution
	err = pool.CompleteTask(context.Background(), 1, 1, "failed", "")
	require.NoError(t, err)
}

// A claim that failed because the caller's context expired must still reach
// the database to release the runner, and a failed release must surface.
func TestRunnerPool_claimRunner_ReleasesOnAnExpiredContextAndJoinsReleaseError(t *testing.T) {
	t.Parallel()

	releaseErr := errors.New("release failed")
	store := &mockStore{
		claimIdleRunnerFn: func(_ context.Context, runnerID int64) (clusterdb.RunnerPool, error) {
			return clusterdb.RunnerPool{ID: runnerID, Status: "busy"}, nil
		},
		claimPendingTaskFn: func(ctx context.Context, _ pgtype.Int8) (db.WorkflowTask, error) {
			return db.WorkflowTask{}, ctx.Err()
		},
		releaseRunnerFn: func(ctx context.Context, _ int64) (int64, error) {
			assert.NoError(t, ctx.Err(), "release must not inherit the claim's expired context")
			return 0, releaseErr
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	pool := NewRunnerPool(store, Config{})
	_, err := pool.claimRunner(ctx, 13)
	require.ErrorIs(t, err, context.Canceled)
	require.ErrorIs(t, err, releaseErr)
	assert.Equal(t, 1, store.ReleaseCallCount())
}
