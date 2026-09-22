package runner

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestNewRunnerPool_ConfiguresHeartbeatTimeout(t *testing.T) {
	t.Parallel()

	store := &mockStore{}

	custom := NewRunnerPool(store, Config{HeartbeatTimeout: 45 * time.Second})
	require.NotNil(t, custom)
	assert.Equal(t, 45*time.Second, custom.heartbeatTimeout)

	defaulted := NewRunnerPool(store, Config{})
	require.NotNil(t, defaulted)
	assert.Equal(t, defaultHeartbeatTimeout, defaulted.heartbeatTimeout)
}

func TestRunnerPool_registerRunner_DelegatesToStore(t *testing.T) {
	t.Parallel()

	var captured clusterdb.UpsertRunnerParams
	store := &mockStore{
		upsertRunnerFn: func(_ context.Context, arg clusterdb.UpsertRunnerParams) (clusterdb.RunnerPool, error) {
			captured = arg
			return clusterdb.RunnerPool{ID: 9, Name: arg.Name, Metadata: arg.Metadata}, nil
		},
	}

	pool := NewRunnerPool(store, Config{})
	metadata := json.RawMessage(`{"labels":{"region":"us-east-1"}}`)
	got, err := pool.registerRunner(context.Background(), RegisterRunnerInput{
		Name:     "runner-1",
		Metadata: metadata,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(9), got.ID)
	assert.Equal(t, "runner-1", captured.Name)
	assert.JSONEq(t, string(metadata), string(captured.Metadata))
}

func TestRunnerPool_releaseRunner_ReleasesBusyRunner(t *testing.T) {
	t.Parallel()

	var releasedID int64
	store := &mockStore{
		releaseRunnerFn: func(_ context.Context, runnerID int64) (int64, error) {
			releasedID = runnerID
			return 1, nil
		},
	}

	pool := NewRunnerPool(store, Config{})
	err := pool.releaseRunner(context.Background(), 23)
	require.NoError(t, err)
	assert.Equal(t, int64(23), releasedID)
}

func TestRunnerPool_terminateRunner_RequeuesTasksBeforeMarkingOffline(t *testing.T) {
	t.Parallel()

	// Issue #129: requeue must happen BEFORE the runner is marked terminated so
	// that a requeue failure leaves the runner un-terminated (still eligible for
	// stale-runner cleanup/retry) rather than stranding its tasks.
	callOrder := make([]string, 0, 2)
	store := &mockStore{
		terminateRunnerFn: func(_ context.Context, runnerID int64) (clusterdb.RunnerPool, error) {
			callOrder = append(callOrder, "terminate-runner")
			assert.Equal(t, int64(31), runnerID)
			return clusterdb.RunnerPool{ID: runnerID, Status: "offline"}, nil
		},
		requeueTasksForRunner: func(_ context.Context, runnerID pgtype.Int8) (int64, error) {
			callOrder = append(callOrder, "requeue-tasks")
			assert.Equal(t, int64(31), runnerID.Int64)
			assert.True(t, runnerID.Valid)
			return 2, nil
		},
	}

	pool := NewRunnerPool(store, Config{})
	err := pool.terminateRunner(context.Background(), 31)
	require.NoError(t, err)
	assert.Equal(t, []string{"requeue-tasks", "terminate-runner"}, callOrder)
}

func TestRunnerPool_terminateRunner_RequeueFailure_LeavesRunnerUnterminated(t *testing.T) {
	t.Parallel()

	terminateCalled := false
	store := &mockStore{
		terminateRunnerFn: func(_ context.Context, runnerID int64) (clusterdb.RunnerPool, error) {
			terminateCalled = true
			return clusterdb.RunnerPool{ID: runnerID, Status: "offline"}, nil
		},
		requeueTasksForRunner: func(_ context.Context, runnerID pgtype.Int8) (int64, error) {
			return 0, assert.AnError
		},
	}

	pool := NewRunnerPool(store, Config{})
	err := pool.terminateRunner(context.Background(), 31)
	require.Error(t, err)
	assert.False(t, terminateCalled, "TerminateRunner must not be called when requeue fails")
}

func TestRunnerPool_CompleteTask_ForwardsRunnerID(t *testing.T) {
	t.Parallel()

	callOrder := make([]string, 0, 2)
	var captured db.MarkWorkflowTaskDoneParams
	store := &mockStore{
		markTaskDoneFn: func(_ context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error) {
			callOrder = append(callOrder, "mark-task-done")
			captured = arg
			return 1, nil
		},
		releaseRunnerFn: func(_ context.Context, runnerID int64) (int64, error) {
			callOrder = append(callOrder, "release-runner")
			assert.Equal(t, int64(42), runnerID)
			return 1, nil
		},
	}

	pool := NewRunnerPool(store, Config{})
	err := pool.CompleteTask(context.Background(), 91, 42, "done", "")
	require.NoError(t, err)
	assert.Equal(t, []string{"mark-task-done", "release-runner"}, callOrder)
	assert.Equal(t, int64(91), captured.ID)
	assert.Equal(t, int64(42), captured.RunnerID.Int64)
	assert.True(t, captured.RunnerID.Valid)
	assert.Equal(t, "done", captured.Status)
}

func TestRunnerPool_CompleteTask_ReleaseError(t *testing.T) {
	t.Parallel()

	store := &mockStore{
		markTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 1, nil
		},
		releaseRunnerFn: func(_ context.Context, _ int64) (int64, error) {
			return 0, assert.AnError
		},
	}

	pool := NewRunnerPool(store, Config{})
	err := pool.CompleteTask(context.Background(), 91, 42, "done", "")
	require.ErrorIs(t, err, assert.AnError)
}

func TestRunnerPool_CompleteTask_AcknowledgesChildTerminalStatus(t *testing.T) {
	t.Parallel()

	callOrder := make([]string, 0, 4)
	store := &mockStore{
		markTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			callOrder = append(callOrder, "mark-task-done")
			return 0, pgx.ErrNoRows
		},
		getTerminalTaskFn: func(_ context.Context, arg db.GetTerminalWorkflowTaskForRunnerParams) (int64, error) {
			callOrder = append(callOrder, "verify-terminal-owner")
			assert.Equal(t, int64(91), arg.TaskID)
			assert.Equal(t, runnerIDParam(42), arg.RunnerID)
			return 17, nil
		},
		clearTerminalTaskFn: func(_ context.Context, arg clusterdb.ClearTerminalWorkflowTaskRunnerOwnershipParams) (int64, error) {
			callOrder = append(callOrder, "clear-terminal-owner")
			assert.Equal(t, int64(91), arg.TaskID)
			assert.Equal(t, runnerIDParam(42), arg.RunnerID)
			return 1, nil
		},
		releaseRunnerFn: func(_ context.Context, runnerID int64) (int64, error) {
			callOrder = append(callOrder, "release-runner")
			assert.Equal(t, int64(42), runnerID)
			return 1, nil
		},
	}

	err := NewRunnerPool(store, Config{}).CompleteTask(context.Background(), 91, 42, "done", "")
	require.NoError(t, err)
	assert.Equal(t, []string{
		"mark-task-done", "verify-terminal-owner", "clear-terminal-owner", "release-runner",
	}, callOrder)
}

func TestRunnerPool_CompleteTask_StaleAcknowledgementDoesNotReleaseRunner(t *testing.T) {
	t.Parallel()

	released := false
	store := &mockStore{
		markTaskDoneFn: func(context.Context, db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 0, pgx.ErrNoRows
		},
		getTerminalTaskFn: func(context.Context, db.GetTerminalWorkflowTaskForRunnerParams) (int64, error) {
			return 17, nil
		},
		clearTerminalTaskFn: func(context.Context, clusterdb.ClearTerminalWorkflowTaskRunnerOwnershipParams) (int64, error) {
			return 0, nil
		},
		releaseRunnerFn: func(context.Context, int64) (int64, error) {
			released = true
			return 1, nil
		},
	}

	err := NewRunnerPool(store, Config{}).CompleteTask(context.Background(), 91, 42, "done", "")
	require.ErrorIs(t, err, pgx.ErrNoRows)
	assert.False(t, released)
}
