package runner

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Store is the minimal DB surface required by runner pool behavior.
// Note: Dependency resolution is handled by the service layer (RunnerService),
// not the runner pool. The pool only manages task and runner lifecycle states.
type Store interface {
	UpsertRunner(ctx context.Context, arg db.UpsertRunnerParams) (db.RunnerPool, error)
	TouchRunnerHeartbeat(ctx context.Context, id int64) (db.RunnerPool, error)
	ClaimIdleRunner(ctx context.Context, id int64) (db.RunnerPool, error)
	ClaimPendingTask(ctx context.Context, runnerID pgtype.Int8) (db.WorkflowTask, error)
	ReleaseRunner(ctx context.Context, id int64) (int64, error)
	TerminateRunner(ctx context.Context, id int64) (db.RunnerPool, error)
	RequeueTasksForRunner(ctx context.Context, runnerID pgtype.Int8) (int64, error)
	MarkWorkflowTaskRunning(ctx context.Context, arg db.MarkWorkflowTaskRunningParams) (int64, error)
	MarkWorkflowTaskDone(ctx context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error)
	ListStaleRunners(ctx context.Context, cutoffAt pgtype.Timestamptz) ([]db.RunnerPool, error)
	GetWorkflowTaskStepID(ctx context.Context, id int64) (int64, error)
	UpdateWorkflowStepStatusRunning(ctx context.Context, stepID int64) (int64, error)
	UpdateWorkflowStepStatusTerminal(ctx context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error)
}
