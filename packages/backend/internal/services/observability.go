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

func ObserveWorkflowRunCompletion(observer WorkflowRunMetricsObserver, run db.WorkflowRun, status string) {
	if observer == nil || run.ID <= 0 || !IsTerminalWorkflowRunStatus(status) || IsTerminalWorkflowRunStatus(run.Status) {
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
