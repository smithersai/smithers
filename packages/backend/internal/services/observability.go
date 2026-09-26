package services

import (
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"time"
)

type WorkflowRunMetricsObserver interface {
	ObserveWorkflowRunCompletion(status string, seconds float64)
}

type AgentSessionMetricsObserver interface {
	ObserveAgentSessionCompletion(status string)
	ObserveAgentSessionTimeout()
}

// ObserveWorkflowRunCompletion counts a run's transition to status. run is the
// row loaded before the transition; a run that was already terminal was
// counted when it got there.
func ObserveWorkflowRunCompletion(observer WorkflowRunMetricsObserver, run db.WorkflowRun, status string) {
	if IsTerminalWorkflowRunStatus(run.Status) {
		return
	}
	recordWorkflowRunCompletion(observer, run, status)
}

// recordWorkflowRunCompletion counts a completion the caller knows is the
// run's only one, such as a claim-fenced terminal write.
func recordWorkflowRunCompletion(observer WorkflowRunMetricsObserver, run db.WorkflowRun, status string) {
	if observer == nil || run.ID <= 0 || !IsTerminalWorkflowRunStatus(status) {
		return
	}

	startedAt := run.CreatedAt
	if run.StartedAt.Valid {
		startedAt = run.StartedAt.Time
	}

	duration := time.Since(startedAt).Seconds()
	if duration < 0 {
		return
	}

	observer.ObserveWorkflowRunCompletion(status, duration)
}
