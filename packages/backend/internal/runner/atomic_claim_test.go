package runner

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type atomicClaimStore struct {
	Store
	claimFn func(context.Context, int64) (db.ClaimRunnerWorkflowTaskRow, error)
}

func (s *atomicClaimStore) ClaimRunnerWorkflowTask(ctx context.Context, runnerID int64) (db.ClaimRunnerWorkflowTaskRow, error) {
	return s.claimFn(ctx, runnerID)
}

func TestRunnerPool_ClaimTask_UsesAtomicProductionPath(t *testing.T) {
	t.Parallel()

	legacy := &mockStore{
		claimIdleRunnerFn: func(context.Context, int64) (db.RunnerPool, error) {
			t.Fatal("atomic claim must not reserve the runner separately")
			return db.RunnerPool{}, nil
		},
		markTaskRunningFn: func(context.Context, db.MarkWorkflowTaskRunningParams) (int64, error) {
			t.Fatal("atomic claim must not mark the task separately")
			return 0, nil
		},
		releaseRunnerFn: func(context.Context, int64) (int64, error) {
			t.Fatal("atomic claim owns rollback and must not use compensating release")
			return 0, nil
		},
	}
	store := &atomicClaimStore{
		Store: legacy,
		claimFn: func(_ context.Context, runnerID int64) (db.ClaimRunnerWorkflowTaskRow, error) {
			assert.Equal(t, int64(7), runnerID)
			return db.ClaimRunnerWorkflowTaskRow{ID: 42, Status: "running"}, nil
		},
	}

	task, err := NewRunnerPool(store, Config{}).ClaimTask(context.Background(), 7)
	require.NoError(t, err)
	require.NotNil(t, task)
	assert.Equal(t, int64(42), task.ID)
	assert.Equal(t, "running", task.Status)
	assert.Equal(t, 0, legacy.ReleaseCallCount())
}

func TestRunnerPool_ClaimTask_AtomicFailureDoesNotAttemptPartialCleanup(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("atomic claim failed")
	legacy := &mockStore{}
	store := &atomicClaimStore{
		Store: legacy,
		claimFn: func(context.Context, int64) (db.ClaimRunnerWorkflowTaskRow, error) {
			return db.ClaimRunnerWorkflowTaskRow{}, sentinel
		},
	}

	task, err := NewRunnerPool(store, Config{}).ClaimTask(context.Background(), 7)
	assert.Nil(t, task)
	assert.ErrorIs(t, err, sentinel)
	assert.Equal(t, 0, legacy.ReleaseCallCount())

	store.claimFn = func(context.Context, int64) (db.ClaimRunnerWorkflowTaskRow, error) {
		return db.ClaimRunnerWorkflowTaskRow{}, pgx.ErrNoRows
	}
	task, err = NewRunnerPool(store, Config{}).ClaimTask(context.Background(), 7)
	assert.Nil(t, task)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
	assert.Equal(t, 0, legacy.ReleaseCallCount())
}
