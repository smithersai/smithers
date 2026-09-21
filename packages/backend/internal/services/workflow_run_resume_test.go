package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// ─── ResumeRun tests ─────────────────────────────────────────────────────────

func resumeRunStatus(t *testing.T, err error) int {
	t.Helper()
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected *pkgerrors.APIError, got %T", err)
	return apiErr.Status
}

func TestWorkflowRunService_ResumeRun_NilQuerier_ReturnsInternalError(t *testing.T) {
	t.Parallel()
	svc := NewWorkflowRunService(nil)
	err := svc.ResumeRun(context.Background(), 1, 1)
	assert.Equal(t, 500, resumeRunStatus(t, err))
}

func TestWorkflowRunService_ResumeRun_RunNotFound_ReturnsNotFound(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, _ db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, pgx.ErrNoRows
		},
	}
	svc := NewWorkflowRunService(mock)
	err := svc.ResumeRun(context.Background(), 42, 999)
	assert.Equal(t, 404, resumeRunStatus(t, err))
}

func TestWorkflowRunService_ResumeRun_CancelledRun_ResumesSuccessfully(t *testing.T) {
	t.Parallel()

	callOrder := make([]string, 0, 4)
	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			callOrder = append(callOrder, "get")
			return db.WorkflowRun{
				ID:           arg.ID,
				RepositoryID: arg.RepositoryID,
				Status:       "cancelled",
			}, nil
		},
		resumeTasksFn: func(_ context.Context, id int64) error {
			callOrder = append(callOrder, "resume_tasks")
			assert.Equal(t, int64(7), id)
			return nil
		},
		resumeStepsFn: func(_ context.Context, id int64) error {
			callOrder = append(callOrder, "resume_steps")
			assert.Equal(t, int64(7), id)
			return nil
		},
		resumeRunFn: func(_ context.Context, id int64) error {
			callOrder = append(callOrder, "resume_run")
			assert.Equal(t, int64(7), id)
			return nil
		},
	}

	svc := NewWorkflowRunService(mock)
	err := svc.ResumeRun(context.Background(), 42, 7)
	require.NoError(t, err)
	assert.Equal(t, []string{"get", "resume_tasks", "resume_steps", "resume_run"}, callOrder)
	assert.Equal(t, []int64{7}, mock.resumeRunCalls)
	assert.Equal(t, []int64{7}, mock.resumeTasksCalls)
	assert.Equal(t, []int64{7}, mock.resumeStepsCalls)
}

func TestWorkflowRunService_ResumeRun_FailedRun_ResumesSuccessfully(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{
				ID:           arg.ID,
				RepositoryID: arg.RepositoryID,
				Status:       "failure",
			}, nil
		},
	}

	svc := NewWorkflowRunService(mock)
	err := svc.ResumeRun(context.Background(), 42, 7)
	require.NoError(t, err)
	assert.Equal(t, []int64{7}, mock.resumeRunCalls)
	assert.Equal(t, []int64{7}, mock.resumeTasksCalls)
	assert.Equal(t, []int64{7}, mock.resumeStepsCalls)
}

func TestWorkflowRunService_ResumeRun_RejectsInternalAlertRemediation(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{
				ID: arg.ID, RepositoryID: arg.RepositoryID, Status: "failure",
				TriggerEvent: AlertRemediationTriggerEvent,
			}, nil
		},
	}

	err := NewWorkflowRunService(mock).ResumeRun(context.Background(), 42, 7)
	assert.Equal(t, 409, resumeRunStatus(t, err))
	assert.Contains(t, err.Error(), "cannot be resumed or rerun")
	assert.Empty(t, mock.resumeTasksCalls)
	assert.Empty(t, mock.resumeStepsCalls)
	assert.Empty(t, mock.resumeRunCalls)
}

func TestWorkflowRunService_ResumeRun_BlocksWhileCancelledTaskRunnerIsUnsettled(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: arg.ID, RepositoryID: arg.RepositoryID, Status: "cancelled"}, nil
		},
		hasUnsettledRunnerOwnershipFn: func(_ context.Context, workflowRunID int64) (bool, error) {
			assert.Equal(t, int64(7), workflowRunID)
			return true, nil
		},
	}

	err := NewWorkflowRunService(mock).ResumeRun(context.Background(), 42, 7)
	assert.Equal(t, 409, resumeRunStatus(t, err))
	assert.Contains(t, err.Error(), "runner is still settling")
	assert.Empty(t, mock.resumeTasksCalls)
	assert.Empty(t, mock.resumeStepsCalls)
	assert.Empty(t, mock.resumeRunCalls)
}

func TestWorkflowRunService_ResumeRun_RunnerOwnershipCheckFailureIsInternal(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: arg.ID, RepositoryID: arg.RepositoryID, Status: "failure"}, nil
		},
		hasUnsettledRunnerOwnershipFn: func(context.Context, int64) (bool, error) {
			return false, errors.New("ownership lookup failed")
		},
	}

	err := NewWorkflowRunService(mock).ResumeRun(context.Background(), 42, 7)
	assert.Equal(t, 500, resumeRunStatus(t, err))
	assert.Empty(t, mock.resumeTasksCalls)
	assert.Empty(t, mock.resumeStepsCalls)
	assert.Empty(t, mock.resumeRunCalls)
}

func TestWorkflowRunService_ResumeRun_CompletedRun_ReturnsConflict(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{
				ID:           arg.ID,
				RepositoryID: arg.RepositoryID,
				Status:       "success",
			}, nil
		},
	}

	svc := NewWorkflowRunService(mock)
	err := svc.ResumeRun(context.Background(), 42, 7)
	assert.Equal(t, 409, resumeRunStatus(t, err))
	assert.Contains(t, err.Error(), "success")
	assert.Empty(t, mock.resumeRunCalls)
	assert.Empty(t, mock.resumeTasksCalls)
	assert.Empty(t, mock.resumeStepsCalls)
}

func TestWorkflowRunService_ResumeRun_RunningRun_ReturnsConflict(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{
				ID:           arg.ID,
				RepositoryID: arg.RepositoryID,
				Status:       "running",
			}, nil
		},
	}

	svc := NewWorkflowRunService(mock)
	err := svc.ResumeRun(context.Background(), 42, 7)
	assert.Equal(t, 409, resumeRunStatus(t, err))
	assert.Contains(t, err.Error(), "running")
	assert.Empty(t, mock.resumeRunCalls)
	assert.Empty(t, mock.resumeTasksCalls)
	assert.Empty(t, mock.resumeStepsCalls)
}

func TestWorkflowRunService_ResumeRun_QueuedRun_ReturnsConflict(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{
				ID:           arg.ID,
				RepositoryID: arg.RepositoryID,
				Status:       "queued",
			}, nil
		},
	}

	svc := NewWorkflowRunService(mock)
	err := svc.ResumeRun(context.Background(), 42, 7)
	assert.Equal(t, 409, resumeRunStatus(t, err))
	assert.Contains(t, err.Error(), "queued")
	assert.Empty(t, mock.resumeRunCalls)
}

func TestWorkflowRunService_ResumeRun_ResumeTasksError_ReturnsInternalError(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{
				ID:           arg.ID,
				RepositoryID: arg.RepositoryID,
				Status:       "cancelled",
			}, nil
		},
		resumeTasksFn: func(_ context.Context, _ int64) error {
			return errors.New("db down")
		},
	}

	svc := NewWorkflowRunService(mock)
	err := svc.ResumeRun(context.Background(), 42, 7)
	assert.Equal(t, 500, resumeRunStatus(t, err))
	assert.Empty(t, mock.resumeRunCalls)
}

func TestWorkflowRunService_ResumeRun_ResumeStepsError_ReturnsInternalError(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{
				ID:           arg.ID,
				RepositoryID: arg.RepositoryID,
				Status:       "failure",
			}, nil
		},
		resumeStepsFn: func(_ context.Context, _ int64) error {
			return errors.New("db down")
		},
	}

	svc := NewWorkflowRunService(mock)
	err := svc.ResumeRun(context.Background(), 42, 7)
	assert.Equal(t, 500, resumeRunStatus(t, err))
	assert.Equal(t, []int64{7}, mock.resumeTasksCalls)
	assert.Empty(t, mock.resumeRunCalls)
}

func TestWorkflowRunService_ResumeRun_ResumeRunError_ReturnsInternalError(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{
				ID:           arg.ID,
				RepositoryID: arg.RepositoryID,
				Status:       "cancelled",
			}, nil
		},
		resumeRunFn: func(_ context.Context, _ int64) error {
			return errors.New("db down")
		},
	}

	svc := NewWorkflowRunService(mock)
	err := svc.ResumeRun(context.Background(), 42, 7)
	assert.Equal(t, 500, resumeRunStatus(t, err))
	assert.Equal(t, []int64{7}, mock.resumeTasksCalls)
	assert.Equal(t, []int64{7}, mock.resumeStepsCalls)
}
