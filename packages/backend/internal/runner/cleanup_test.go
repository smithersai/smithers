package runner

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestRunnerPool_cleanupStaleRunners_TerminatesEachStaleRunner(t *testing.T) {
	t.Parallel()

	baseNow := time.Date(2026, 2, 21, 12, 0, 0, 0, time.UTC)
	timeout := 75 * time.Second
	cutoff := baseNow.Add(-timeout)
	callOrder := make([]string, 0, 5)

	store := &mockStore{
		listStaleRunnersFn: func(_ context.Context, cutoffAt pgtype.Timestamptz) ([]db.RunnerPool, error) {
			callOrder = append(callOrder, "list-stale")
			require.True(t, cutoffAt.Valid)
			assert.Equal(t, cutoff, cutoffAt.Time)
			return []db.RunnerPool{
				{ID: 100, Status: "idle"},
				{ID: 101, Status: "busy"},
			}, nil
		},
		terminateRunnerFn: func(_ context.Context, runnerID int64) (db.RunnerPool, error) {
			callOrder = append(callOrder, "terminate")
			return db.RunnerPool{ID: runnerID, Status: "offline"}, nil
		},
		requeueTasksForRunner: func(_ context.Context, runnerID pgtype.Int8) (int64, error) {
			callOrder = append(callOrder, "requeue")
			return 1, nil
		},
	}

	pool := NewRunnerPool(store, Config{HeartbeatTimeout: timeout})
	pool.now = func() time.Time { return baseNow }

	cleaned, err := pool.cleanupStaleRunners(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 2, cleaned)
	// Issue #129: requeue must happen before terminate for each stale runner.
	assert.Equal(t, []string{"list-stale", "requeue", "terminate", "requeue", "terminate"}, callOrder)
}

func TestRunnerPool_cleanupStaleRunners_RecoversTasks(t *testing.T) {
	t.Parallel()

	requeued := 0
	store := &mockStore{
		listStaleRunnersFn: func(_ context.Context, cutoffAt pgtype.Timestamptz) ([]db.RunnerPool, error) {
			return []db.RunnerPool{{ID: 71, Status: "busy"}}, nil
		},
		terminateRunnerFn: func(_ context.Context, runnerID int64) (db.RunnerPool, error) {
			return db.RunnerPool{ID: runnerID, Status: "offline"}, nil
		},
		requeueTasksForRunner: func(_ context.Context, runnerID pgtype.Int8) (int64, error) {
			requeued++
			assert.Equal(t, int64(71), runnerID.Int64)
			assert.True(t, runnerID.Valid)
			return 3, nil
		},
	}

	pool := NewRunnerPool(store, Config{HeartbeatTimeout: 60 * time.Second})
	cleaned, err := pool.cleanupStaleRunners(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 1, cleaned)
	assert.Equal(t, 1, requeued)
}

func TestRunnerPool_cleanupStaleRunners_ContinuesAfterRunnerError(t *testing.T) {
	t.Parallel()

	var requeuedIDs []int64
	store := &mockStore{
		listStaleRunnersFn: func(_ context.Context, cutoffAt pgtype.Timestamptz) ([]db.RunnerPool, error) {
			return []db.RunnerPool{
				{ID: 70, Status: "busy"},
				{ID: 71, Status: "busy"},
			}, nil
		},
		terminateRunnerFn: func(_ context.Context, runnerID int64) (db.RunnerPool, error) {
			if runnerID == 70 {
				return db.RunnerPool{}, errors.New("db unavailable")
			}
			return db.RunnerPool{ID: runnerID, Status: "offline"}, nil
		},
		requeueTasksForRunner: func(_ context.Context, runnerID pgtype.Int8) (int64, error) {
			// Issue #129: requeue happens before terminate, so it is attempted
			// (and succeeds) for both stale runners regardless of runner 70's
			// subsequent terminate failure.
			requeuedIDs = append(requeuedIDs, runnerID.Int64)
			return 1, nil
		},
	}

	pool := NewRunnerPool(store, Config{HeartbeatTimeout: 60 * time.Second})
	cleaned, err := pool.cleanupStaleRunners(context.Background())
	require.Error(t, err)
	assert.Equal(t, 1, cleaned)
	assert.Contains(t, err.Error(), "terminate stale runner 70")
	assert.ElementsMatch(t, []int64{70, 71}, requeuedIDs)
}
