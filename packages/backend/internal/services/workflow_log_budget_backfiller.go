package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	defaultWorkflowLogBudgetBackfillActiveInterval = 100 * time.Millisecond
	defaultWorkflowLogBudgetBackfillIdleInterval   = 30 * time.Second
)

// WorkflowLogBudgetBackfillQuerier is the single, bounded database operation
// used to initialize legacy workflow-run log counters. Each call locks and
// recounts at most one run in its own transaction.
type WorkflowLogBudgetBackfillQuerier interface {
	BackfillOneWorkflowLogBudget(ctx context.Context) (int64, error)
}

// WorkflowLogBudgetBackfiller incrementally initializes exact log counters for
// runs created before counter-backed admission was installed. Multiple API
// replicas may run it concurrently; the database function uses SKIP LOCKED.
type WorkflowLogBudgetBackfiller struct {
	queries        WorkflowLogBudgetBackfillQuerier
	logger         *slog.Logger
	activeInterval time.Duration
	idleInterval   time.Duration
}

func NewWorkflowLogBudgetBackfiller(queries WorkflowLogBudgetBackfillQuerier) *WorkflowLogBudgetBackfiller {
	return &WorkflowLogBudgetBackfiller{
		queries:        queries,
		logger:         slog.Default(),
		activeInterval: defaultWorkflowLogBudgetBackfillActiveInterval,
		idleInterval:   defaultWorkflowLogBudgetBackfillIdleInterval,
	}
}

// PollOnce initializes one run. A false result is the normal completed/idle
// signal, not an error.
func (w *WorkflowLogBudgetBackfiller) PollOnce(ctx context.Context) (bool, error) {
	if w == nil || w.queries == nil {
		return false, nil
	}
	runID, err := w.queries.BackfillOneWorkflowLogBudget(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("backfill one workflow log budget: %w", err)
	}
	w.logger.Debug("workflow log budget initialized", "workflow_run_id", runID)
	return true, nil
}

// Start drains legacy runs gradually and then remains available for a resumed
// rollout. It exits promptly when ctx is cancelled.
func (w *WorkflowLogBudgetBackfiller) Start(ctx context.Context) {
	for {
		processed, err := w.PollOnce(ctx)
		if err != nil && ctx.Err() == nil {
			w.logger.Error("workflow log budget backfill failed", "error", err)
		}
		if ctx.Err() != nil {
			return
		}

		delay := w.idleInterval
		if processed {
			delay = w.activeInterval
		}
		if delay <= 0 {
			delay = defaultWorkflowLogBudgetBackfillIdleInterval
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return
		case <-timer.C:
		}
	}
}
