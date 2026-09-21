package clusterservices

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type atomicRunnerQuerier struct {
	RunnerQuerier
	claimFn  func(context.Context, int64) (db.ClaimRunnerWorkflowTaskRow, error)
	statusFn func(context.Context, int64) (string, error)
}

func (q *atomicRunnerQuerier) ClaimRunnerWorkflowTask(ctx context.Context, runnerID int64) (db.ClaimRunnerWorkflowTaskRow, error) {
	return q.claimFn(ctx, runnerID)
}

func (q *atomicRunnerQuerier) GetRunnerStatus(ctx context.Context, runnerID int64) (string, error) {
	return q.statusFn(ctx, runnerID)
}

func TestRunnerService_ClaimTask_UsesAtomicProductionPath(t *testing.T) {
	t.Parallel()

	legacy := &mockRunnerQuerier{
		claimIdleRunnerFn: func(context.Context, int64) (db.RunnerPool, error) {
			t.Fatal("atomic claim must not reserve the runner separately")
			return db.RunnerPool{}, nil
		},
		markWorkflowTaskRunningFn: func(context.Context, db.MarkWorkflowTaskRunningParams) (int64, error) {
			t.Fatal("atomic claim must not mark the task separately")
			return 0, nil
		},
		releaseRunnerFn: func(context.Context, int64) (int64, error) {
			t.Fatal("atomic claim errors roll back in PostgreSQL and must not use compensating release")
			return 0, nil
		},
	}
	querier := &atomicRunnerQuerier{
		RunnerQuerier: legacy,
		claimFn: func(_ context.Context, runnerID int64) (db.ClaimRunnerWorkflowTaskRow, error) {
			assert.Equal(t, int64(7), runnerID)
			return db.ClaimRunnerWorkflowTaskRow{
				ID:             42,
				WorkflowRunID:  99,
				WorkflowStepID: 321,
				RepositoryID:   123,
				Status:         "running",
				Attempt:        3,
				Payload:        []byte(`{"job":"build"}`),
			}, nil
		},
	}

	task, err := NewRunnerService(querier).ClaimTask(context.Background(), 7)
	require.NoError(t, err)
	require.NotNil(t, task)
	assert.Equal(t, int64(42), task.ID)
	assert.Equal(t, int64(99), task.WorkflowRunID)
	assert.Equal(t, int64(321), task.WorkflowStepID)
	assert.Equal(t, int64(123), task.RepositoryID)
	assert.Equal(t, int32(3), task.Attempt)
}

func TestRunnerService_ClaimTask_AtomicPathHandlesEmptyQueueAndErrors(t *testing.T) {
	t.Parallel()

	t.Run("empty queue", func(t *testing.T) {
		querier := &atomicRunnerQuerier{
			RunnerQuerier: &mockRunnerQuerier{},
			claimFn: func(context.Context, int64) (db.ClaimRunnerWorkflowTaskRow, error) {
				return db.ClaimRunnerWorkflowTaskRow{}, pgx.ErrNoRows
			},
			statusFn: func(_ context.Context, runnerID int64) (string, error) {
				assert.Equal(t, int64(7), runnerID)
				return "idle", nil
			},
		}

		task, err := NewRunnerService(querier).ClaimTask(context.Background(), 7)
		require.NoError(t, err)
		assert.Nil(t, task)
	})

	t.Run("runner unavailable", func(t *testing.T) {
		for _, status := range []string{"busy", "draining", "offline"} {
			t.Run(status, func(t *testing.T) {
				querier := &atomicRunnerQuerier{
					RunnerQuerier: &mockRunnerQuerier{},
					claimFn: func(context.Context, int64) (db.ClaimRunnerWorkflowTaskRow, error) {
						return db.ClaimRunnerWorkflowTaskRow{}, pgx.ErrNoRows
					},
					statusFn: func(context.Context, int64) (string, error) {
						return status, nil
					},
				}

				_, err := NewRunnerService(querier).ClaimTask(context.Background(), 7)
				assert.Equal(t, 409, runnerAPIStatus(t, err))
			})
		}
	})

	t.Run("runner missing", func(t *testing.T) {
		querier := &atomicRunnerQuerier{
			RunnerQuerier: &mockRunnerQuerier{},
			claimFn: func(context.Context, int64) (db.ClaimRunnerWorkflowTaskRow, error) {
				return db.ClaimRunnerWorkflowTaskRow{}, pgx.ErrNoRows
			},
			statusFn: func(context.Context, int64) (string, error) {
				return "", pgx.ErrNoRows
			},
		}

		_, err := NewRunnerService(querier).ClaimTask(context.Background(), 7)
		assert.Equal(t, 409, runnerAPIStatus(t, err))
	})

	t.Run("database failure", func(t *testing.T) {
		sentinel := errors.New("atomic claim failed")
		querier := &atomicRunnerQuerier{
			RunnerQuerier: &mockRunnerQuerier{
				releaseRunnerFn: func(context.Context, int64) (int64, error) {
					t.Fatal("failed atomic statement must not be followed by a partial cleanup")
					return 0, nil
				},
			},
			claimFn: func(context.Context, int64) (db.ClaimRunnerWorkflowTaskRow, error) {
				return db.ClaimRunnerWorkflowTaskRow{}, sentinel
			},
		}

		_, err := NewRunnerService(querier).ClaimTask(context.Background(), 7)
		assert.Equal(t, 500, runnerAPIStatus(t, err))
	})
}
