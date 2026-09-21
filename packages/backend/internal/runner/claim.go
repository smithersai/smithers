package runner

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func (p *RunnerPool) claimRunner(ctx context.Context, runnerID int64) (db.WorkflowTask, error) {
	if _, err := p.store.ClaimIdleRunner(ctx, runnerID); err != nil {
		return db.WorkflowTask{}, err
	}

	task, err := p.store.ClaimPendingTask(ctx, runnerIDParam(runnerID))
	if err == nil {
		return task, nil
	}

	// No task was claimed (no pending work, or the claim query failed);
	// either way the runner must not be left in the busy state.
	if _, releaseErr := p.store.ReleaseRunner(ctx, runnerID); releaseErr != nil && errors.Is(err, pgx.ErrNoRows) {
		return db.WorkflowTask{}, releaseErr
	}
	return db.WorkflowTask{}, err
}

func (p *RunnerPool) markTaskRunning(ctx context.Context, taskID, runnerID int64) error {
	rows, err := p.store.MarkWorkflowTaskRunning(ctx, db.MarkWorkflowTaskRunningParams{
		ID:       taskID,
		RunnerID: runnerIDParam(runnerID),
	})
	if err != nil {
		return err
	}
	if rows == 0 {
		return pgx.ErrNoRows
	}
	return p.updateStepStatus(ctx, taskID, "running")
}

func (p *RunnerPool) updateStepStatus(ctx context.Context, taskID int64, status string) error {
	stepID, err := p.store.GetWorkflowTaskStepID(ctx, taskID)
	if err != nil {
		return err
	}
	if status == "running" {
		if _, err := p.store.UpdateWorkflowStepStatusRunning(ctx, stepID); err != nil {
			return err
		}
	} else {
		if _, err := p.store.UpdateWorkflowStepStatusTerminal(ctx, db.UpdateWorkflowStepStatusTerminalParams{
			Status: status,
			StepID: stepID,
		}); err != nil {
			return err
		}
	}
	return nil
}

func (p *RunnerPool) markTaskDone(ctx context.Context, taskID, runnerID int64, status, lastError string) error {
	_, err := p.store.MarkWorkflowTaskDone(ctx, db.MarkWorkflowTaskDoneParams{
		ID:       taskID,
		RunnerID: runnerIDParam(runnerID),
		Status:   status,
		LastError: pgtype.Text{
			String: lastError,
			Valid:  lastError != "",
		},
	})
	if err != nil {
		return err
	}

	stepStatus := "success"
	if status == "failed" {
		stepStatus = "failure"
	} else if status == "cancelled" {
		stepStatus = "cancelled"
	}
	if err := p.updateStepStatus(ctx, taskID, stepStatus); err != nil {
		return err
	}

	// Note: Dependency resolution is handled by the service layer (RunnerService.progressDependencies),
	// not the pool. The pool only manages task and runner lifecycle states.

	return nil
}

func runnerIDParam(runnerID int64) pgtype.Int8 {
	return pgtype.Int8{Int64: runnerID, Valid: true}
}
