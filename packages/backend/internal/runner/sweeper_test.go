package runner

import (
	"context"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRunStaleSweeperReapsImmediately(t *testing.T) {
	baseNow := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)
	reaped := make(chan int64, 1)
	store := &mockStore{
		listStaleRunnersFn: func(_ context.Context, cutoff pgtype.Timestamptz) ([]clusterdb.RunnerPool, error) {
			assert.Equal(t, baseNow.Add(-2*time.Minute), cutoff.Time)
			return []clusterdb.RunnerPool{{ID: 92, Status: "busy"}}, nil
		},
		requeueTasksForRunner: func(_ context.Context, runnerID pgtype.Int8) (int64, error) {
			assert.Equal(t, int64(92), runnerID.Int64)
			return 1, nil
		},
		terminateRunnerFn: func(_ context.Context, runnerID int64) (clusterdb.RunnerPool, error) {
			reaped <- runnerID
			return clusterdb.RunnerPool{ID: runnerID, Status: "offline"}, nil
		},
	}
	pool := NewRunnerPool(store, Config{HeartbeatTimeout: 2 * time.Minute})
	pool.now = func() time.Time { return baseNow }

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		pool.RunStaleSweeper(ctx, time.Hour)
	}()

	require.Equal(t, int64(92), <-reaped)
	cancel()
	require.Eventually(t, func() bool {
		select {
		case <-done:
			return true
		default:
			return false
		}
	}, time.Second, time.Millisecond)
}

func TestRunStaleSweeperUsesDefaultIntervalForInvalidValue(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	called := 0
	pool := NewRunnerPool(&mockStore{
		listStaleRunnersFn: func(context.Context, pgtype.Timestamptz) ([]clusterdb.RunnerPool, error) {
			called++
			return nil, nil
		},
	}, Config{})
	pool.RunStaleSweeper(ctx, 0)

	assert.Equal(t, 1, called)
}
