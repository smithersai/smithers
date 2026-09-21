package runner

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type terminalTaskSettlementStore interface {
	GetTerminalWorkflowTaskForRunner(ctx context.Context, arg db.GetTerminalWorkflowTaskForRunnerParams) (int64, error)
	ClearTerminalWorkflowTaskRunnerOwnership(ctx context.Context, arg db.ClearTerminalWorkflowTaskRunnerOwnershipParams) (int64, error)
}

// atomicRunnerWorkflowTaskClaimer is the production sqlc fast path. Store
// remains intentionally narrow so existing local test doubles can keep using
// the legacy, individually observable claim transitions.
type atomicRunnerWorkflowTaskClaimer interface {
	ClaimRunnerWorkflowTask(ctx context.Context, runnerID int64) (db.ClaimRunnerWorkflowTaskRow, error)
}

// RegisterRunner upserts a runner entry in the pool and returns the row.
func (p *RunnerPool) RegisterRunner(ctx context.Context, in RegisterRunnerInput) (db.RunnerPool, error) {
	return p.registerRunner(ctx, in)
}

// ClaimRunner transitions the runner to busy and claims a pending task.
// Returns pgx.ErrNoRows if no tasks are available (runner is released back to idle).
func (p *RunnerPool) ClaimRunner(ctx context.Context, runnerID int64) (db.WorkflowTask, error) {
	return p.claimRunner(ctx, runnerID)
}

// MarkTaskRunning transitions the given task to running state.
func (p *RunnerPool) MarkTaskRunning(ctx context.Context, taskID, runnerID int64) error {
	return p.markTaskRunning(ctx, taskID, runnerID)
}

// MarkTaskDone transitions the given task to a terminal state (done/failed/canceled).
func (p *RunnerPool) MarkTaskDone(ctx context.Context, taskID, runnerID int64, status, lastError string) error {
	return p.markTaskDone(ctx, taskID, runnerID, status, lastError)
}

// ReleaseRunner transitions a busy runner back to idle.
func (p *RunnerPool) ReleaseRunner(ctx context.Context, runnerID int64) error {
	return p.releaseRunner(ctx, runnerID)
}

// TerminateRunner marks a runner offline and requeues its assigned tasks with retry backoff.
func (p *RunnerPool) TerminateRunner(ctx context.Context, runnerID int64) error {
	return p.terminateRunner(ctx, runnerID)
}

// ClaimTask claims a pending task for this runner. It preserves claimRunner's
// pgx.ErrNoRows result when no task is available; callers use the nil task to
// distinguish all error paths from a successful claim.
func (p *RunnerPool) ClaimTask(ctx context.Context, runnerID int64) (*db.WorkflowTask, error) {
	if claimer, ok := p.store.(atomicRunnerWorkflowTaskClaimer); ok {
		task, err := claimer.ClaimRunnerWorkflowTask(ctx, runnerID)
		if err != nil {
			return nil, err
		}
		converted := workflowTaskFromAtomicClaim(task)
		return &converted, nil
	}

	task, err := p.claimRunner(ctx, runnerID)
	if err != nil {
		return nil, err
	}
	// claimRunner leaves the task in 'assigned'. The executor.TaskPool contract is
	// ClaimTask -> ... -> CompleteTask, and CompleteTask (MarkWorkflowTaskDone)
	// requires status 'running'. Transition here — mirroring the HTTP
	// runnerService.ClaimTask path — so the direct-DB (local-dev) pool is
	// self-consistent; otherwise every claimed task hangs in 'assigned', the runner
	// is never released, and CompleteTask fails with pgx.ErrNoRows.
	if err := p.markTaskRunning(ctx, task.ID, runnerID); err != nil {
		_, _ = p.store.ReleaseRunner(ctx, runnerID)
		return nil, err
	}
	return &task, nil
}

func workflowTaskFromAtomicClaim(task db.ClaimRunnerWorkflowTaskRow) db.WorkflowTask {
	return db.WorkflowTask(task)
}

// CompleteTask settles a task only after the executor has completed its
// post-command quarantine. The exact task/runner binding is retained through
// terminal settlement so a stale acknowledgement cannot release a reused
// runner lease.
func (p *RunnerPool) CompleteTask(ctx context.Context, taskID int64, runnerID int64, status, errorMessage string) error {
	settler, ok := p.store.(terminalTaskSettlementStore)
	if !ok {
		return fmt.Errorf("runner task settlement unavailable")
	}
	if err := p.markTaskDone(ctx, taskID, runnerID, status, errorMessage); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if _, terminalErr := settler.GetTerminalWorkflowTaskForRunner(ctx, db.GetTerminalWorkflowTaskForRunnerParams{
			TaskID:   taskID,
			RunnerID: runnerIDParam(runnerID),
		}); terminalErr != nil {
			return terminalErr
		}
	}
	cleared, err := settler.ClearTerminalWorkflowTaskRunnerOwnership(ctx, db.ClearTerminalWorkflowTaskRunnerOwnershipParams{
		TaskID:   taskID,
		RunnerID: runnerIDParam(runnerID),
	})
	if err != nil {
		return err
	}
	if cleared == 0 {
		return pgx.ErrNoRows
	}
	return p.releaseRunner(ctx, runnerID)
}

// CleanupStaleRunners terminates runners that haven't heartbeated within the timeout
// and requeues their assigned tasks with retry backoff. Returns the count of cleaned runners.
func (p *RunnerPool) CleanupStaleRunners(ctx context.Context) (int, error) {
	return p.cleanupStaleRunners(ctx)
}

func (p *RunnerPool) registerRunner(ctx context.Context, in RegisterRunnerInput) (db.RunnerPool, error) {
	return p.store.UpsertRunner(ctx, db.UpsertRunnerParams{
		Name:     in.Name,
		Metadata: in.Metadata,
	})
}

func (p *RunnerPool) releaseRunner(ctx context.Context, runnerID int64) error {
	_, err := p.store.ReleaseRunner(ctx, runnerID)
	return err
}

// terminateRunner requeues the runner's assigned/running tasks BEFORE marking
// it terminated (issue #129). If requeue fails, the runner is deliberately
// left un-terminated: its heartbeats have already stopped, so it remains
// eligible for stale-runner cleanup/retry instead of leaving its tasks
// stranded on a runner that looks terminated but never got its work requeued.
func (p *RunnerPool) terminateRunner(ctx context.Context, runnerID int64) error {
	if _, err := p.store.RequeueTasksForRunner(ctx, runnerIDParam(runnerID)); err != nil {
		return err
	}

	_, err := p.store.TerminateRunner(ctx, runnerID)
	return err
}
