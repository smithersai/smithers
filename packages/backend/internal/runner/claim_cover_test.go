package runner

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type claimCovStore struct {
	*mockStore

	getWorkflowTaskStepIDFn               func(ctx context.Context, id int64) (int64, error)
	updateWorkflowStepStatusRunningFn     func(ctx context.Context, stepID int64) (int64, error)
	updateWorkflowStepStatusTerminalFn    func(ctx context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error)
	unexpectedWorkflowStepStatusUpdateHit bool
}

func (s *claimCovStore) GetWorkflowTaskStepID(ctx context.Context, id int64) (int64, error) {
	if s.getWorkflowTaskStepIDFn != nil {
		return s.getWorkflowTaskStepIDFn(ctx, id)
	}
	return s.mockStore.GetWorkflowTaskStepID(ctx, id)
}

func (s *claimCovStore) UpdateWorkflowStepStatusRunning(ctx context.Context, stepID int64) (int64, error) {
	if s.updateWorkflowStepStatusRunningFn != nil {
		return s.updateWorkflowStepStatusRunningFn(ctx, stepID)
	}
	s.unexpectedWorkflowStepStatusUpdateHit = true
	return s.mockStore.UpdateWorkflowStepStatusRunning(ctx, stepID)
}

func (s *claimCovStore) UpdateWorkflowStepStatusTerminal(ctx context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error) {
	if s.updateWorkflowStepStatusTerminalFn != nil {
		return s.updateWorkflowStepStatusTerminalFn(ctx, arg)
	}
	s.unexpectedWorkflowStepStatusUpdateHit = true
	return s.mockStore.UpdateWorkflowStepStatusTerminal(ctx, arg)
}

func TestClaim_Cov_ClaimRunnerClaimIdleError(t *testing.T) {
	t.Parallel()

	claimErr := errors.New("runner not idle")
	store := &mockStore{
		claimIdleRunnerFn: func(_ context.Context, runnerID int64) (db.RunnerPool, error) {
			assert.Equal(t, int64(12), runnerID)
			return db.RunnerPool{}, claimErr
		},
		claimPendingTaskFn: func(context.Context, pgtype.Int8) (db.WorkflowTask, error) {
			require.Fail(t, "claim pending task should not run when claiming the runner fails")
			return db.WorkflowTask{}, nil
		},
	}

	pool := NewRunnerPool(store, Config{})
	_, err := pool.claimRunner(context.Background(), 12)
	require.ErrorIs(t, err, claimErr)
	assert.Equal(t, 0, store.ReleaseCallCount())
}

func TestClaim_Cov_ClaimRunnerReturnsReleaseErrorForNoRows(t *testing.T) {
	t.Parallel()

	releaseErr := errors.New("release failed")
	store := &mockStore{
		claimIdleRunnerFn: func(_ context.Context, runnerID int64) (db.RunnerPool, error) {
			return db.RunnerPool{ID: runnerID, Status: "busy"}, nil
		},
		claimPendingTaskFn: func(context.Context, pgtype.Int8) (db.WorkflowTask, error) {
			return db.WorkflowTask{}, pgx.ErrNoRows
		},
		releaseRunnerFn: func(_ context.Context, runnerID int64) (int64, error) {
			assert.Equal(t, int64(13), runnerID)
			return 0, releaseErr
		},
	}

	pool := NewRunnerPool(store, Config{})
	_, err := pool.claimRunner(context.Background(), 13)
	require.ErrorIs(t, err, releaseErr)
	assert.Equal(t, 1, store.ReleaseCallCount())
}

func TestClaim_Cov_MarkTaskRunningStoreErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		rows    int64
		err     error
		wantErr error
	}{
		{name: "store error", err: errors.New("mark running failed"), wantErr: errors.New("mark running failed")},
		{name: "no rows", rows: 0, wantErr: pgx.ErrNoRows},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			store := &mockStore{
				markTaskRunningFn: func(_ context.Context, arg db.MarkWorkflowTaskRunningParams) (int64, error) {
					assert.Equal(t, int64(20), arg.ID)
					assert.Equal(t, int64(7), arg.RunnerID.Int64)
					if tt.err != nil {
						return 0, tt.err
					}
					return tt.rows, nil
				},
			}

			pool := NewRunnerPool(store, Config{})
			err := pool.markTaskRunning(context.Background(), 20, 7)
			require.Error(t, err)
			if tt.err != nil {
				assert.EqualError(t, err, tt.err.Error())
			} else {
				assert.ErrorIs(t, err, tt.wantErr)
			}
		})
	}
}

func TestClaim_Cov_UpdateStepStatusErrorBranches(t *testing.T) {
	t.Parallel()

	t.Run("get step id error", func(t *testing.T) {
		t.Parallel()

		stepErr := errors.New("step lookup failed")
		store := &claimCovStore{
			mockStore: &mockStore{},
			getWorkflowTaskStepIDFn: func(_ context.Context, id int64) (int64, error) {
				assert.Equal(t, int64(30), id)
				return 0, stepErr
			},
		}

		pool := NewRunnerPool(store, Config{})
		err := pool.updateStepStatus(context.Background(), 30, "running")
		require.ErrorIs(t, err, stepErr)
		assert.False(t, store.unexpectedWorkflowStepStatusUpdateHit)
	})

	t.Run("running update error", func(t *testing.T) {
		t.Parallel()

		updateErr := errors.New("running update failed")
		store := &claimCovStore{
			mockStore: &mockStore{},
			getWorkflowTaskStepIDFn: func(_ context.Context, id int64) (int64, error) {
				assert.Equal(t, int64(31), id)
				return 301, nil
			},
			updateWorkflowStepStatusRunningFn: func(_ context.Context, stepID int64) (int64, error) {
				assert.Equal(t, int64(301), stepID)
				return 0, updateErr
			},
		}

		pool := NewRunnerPool(store, Config{})
		err := pool.updateStepStatus(context.Background(), 31, "running")
		require.ErrorIs(t, err, updateErr)
	})

	t.Run("terminal update error", func(t *testing.T) {
		t.Parallel()

		updateErr := errors.New("terminal update failed")
		store := &claimCovStore{
			mockStore: &mockStore{},
			getWorkflowTaskStepIDFn: func(_ context.Context, id int64) (int64, error) {
				assert.Equal(t, int64(32), id)
				return 302, nil
			},
			updateWorkflowStepStatusTerminalFn: func(_ context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error) {
				assert.Equal(t, int64(302), arg.StepID)
				assert.Equal(t, "failure", arg.Status)
				return 0, updateErr
			},
		}

		pool := NewRunnerPool(store, Config{})
		err := pool.updateStepStatus(context.Background(), 32, "failure")
		require.ErrorIs(t, err, updateErr)
	})
}

func TestClaim_Cov_MarkTaskDonePropagatesStoreError(t *testing.T) {
	t.Parallel()

	doneErr := errors.New("mark done failed")
	store := &mockStore{
		markTaskDoneFn: func(_ context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error) {
			assert.Equal(t, int64(40), arg.ID)
			assert.Equal(t, int64(8), arg.RunnerID.Int64)
			return 0, doneErr
		},
	}

	pool := NewRunnerPool(store, Config{})
	err := pool.markTaskDone(context.Background(), 40, 8, "failed", "boom")
	require.ErrorIs(t, err, doneErr)
}

func TestClaim_Cov_MarkTaskDoneMapsTerminalStatusesAndLastError(t *testing.T) {
	t.Parallel()

	tests := []struct {
		status         string
		lastError      string
		wantStepStatus string
		wantLastValid  bool
	}{
		{status: "failed", lastError: "process exited 1", wantStepStatus: "failure", wantLastValid: true},
		{status: "cancelled", wantStepStatus: "cancelled"},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.status, func(t *testing.T) {
			t.Parallel()

			store := &claimCovStore{
				mockStore: &mockStore{
					markTaskDoneFn: func(_ context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error) {
						assert.Equal(t, int64(41), arg.ID)
						assert.Equal(t, int64(9), arg.RunnerID.Int64)
						assert.Equal(t, tt.status, arg.Status)
						assert.Equal(t, tt.lastError, arg.LastError.String)
						assert.Equal(t, tt.wantLastValid, arg.LastError.Valid)
						return 1, nil
					},
				},
				getWorkflowTaskStepIDFn: func(_ context.Context, id int64) (int64, error) {
					assert.Equal(t, int64(41), id)
					return 401, nil
				},
				updateWorkflowStepStatusTerminalFn: func(_ context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error) {
					assert.Equal(t, int64(401), arg.StepID)
					assert.Equal(t, tt.wantStepStatus, arg.Status)
					return 1, nil
				},
			}

			pool := NewRunnerPool(store, Config{})
			err := pool.markTaskDone(context.Background(), 41, 9, tt.status, tt.lastError)
			require.NoError(t, err)
		})
	}
}

func TestClaim_Cov_MarkTaskDoneReturnsStepUpdateError(t *testing.T) {
	t.Parallel()

	stepErr := errors.New("step status failed")
	store := &claimCovStore{
		mockStore: &mockStore{
			markTaskDoneFn: func(context.Context, db.MarkWorkflowTaskDoneParams) (int64, error) {
				return 1, nil
			},
		},
		getWorkflowTaskStepIDFn: func(context.Context, int64) (int64, error) {
			return 0, stepErr
		},
	}

	pool := NewRunnerPool(store, Config{})
	err := pool.markTaskDone(context.Background(), 42, 9, "done", "")
	require.ErrorIs(t, err, stepErr)
}
