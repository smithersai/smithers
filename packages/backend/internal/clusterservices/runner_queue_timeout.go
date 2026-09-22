package clusterservices

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
)

const (
	runnerQueueTimeoutSweepInterval = 30 * time.Second
	runnerQueueTimeoutSweepLimit    = 100
)

type runnerQueueTimeoutStore interface {
	ListExpiredQueuedRunnerWorkflowRuns(context.Context, int32) ([]clusterdb.ListExpiredQueuedRunnerWorkflowRunsRow, error)
	MarkQueuedRunnerWorkflowRunTimeout(context.Context, clusterdb.MarkQueuedRunnerWorkflowRunTimeoutParams) (int64, error)
}

type runnerQueueCanceller interface {
	CancelRun(context.Context, int64, int64) error
}

// RunnerQueueTimeoutWorker turns an unclaimed runner run into an explicit
// cancellation after its oldest ready task has waited 120 seconds. It uses the
// ordinary cancellation service to settle tasks, tokens and external checks.
type RunnerQueueTimeoutWorker struct {
	store     runnerQueueTimeoutStore
	canceller runnerQueueCanceller
}

func NewRunnerQueueTimeoutWorker(store runnerQueueTimeoutStore, canceller runnerQueueCanceller) *RunnerQueueTimeoutWorker {
	return &RunnerQueueTimeoutWorker{store: store, canceller: canceller}
}

func (w *RunnerQueueTimeoutWorker) PollOnce(ctx context.Context) error {
	runs, err := w.store.ListExpiredQueuedRunnerWorkflowRuns(ctx, runnerQueueTimeoutSweepLimit)
	if err != nil {
		return fmt.Errorf("list expired runner workflow runs: %w", err)
	}
	var failures []error
	for _, run := range runs {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(failures, err)...)
		}
		marked, err := w.store.MarkQueuedRunnerWorkflowRunTimeout(ctx, clusterdb.MarkQueuedRunnerWorkflowRunTimeoutParams{
			RunID: run.ID, RepositoryID: run.RepositoryID,
		})
		if err != nil {
			failures = append(failures, fmt.Errorf("mark runner queue timeout for run %d: %w", run.ID, err))
			continue
		}
		if marked == 0 {
			continue // another owner started or cancelled the run
		}
		if err := w.canceller.CancelRun(ctx, run.RepositoryID, run.ID); err != nil {
			failures = append(failures, fmt.Errorf("cancel expired runner workflow run %d: %w", run.ID, err))
			continue
		}
		slog.Warn("runner workflow run cancelled after queue timeout", "run_id", run.ID, "repository_id", run.RepositoryID)
	}
	return errors.Join(failures...)
}

func (w *RunnerQueueTimeoutWorker) Start(ctx context.Context) {
	ticker := time.NewTicker(runnerQueueTimeoutSweepInterval)
	defer ticker.Stop()
	for {
		if err := w.PollOnce(ctx); err != nil && ctx.Err() == nil {
			slog.Error("runner queue timeout sweep failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
