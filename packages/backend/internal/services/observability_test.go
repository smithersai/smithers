package services

import (
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

type fakeWorkflowRunMetricsObserver struct {
	count   int
	status  string
	seconds float64
}

func (f *fakeWorkflowRunMetricsObserver) ObserveWorkflowRunCompletion(status string, seconds float64) {
	f.count++
	f.status = status
	f.seconds = seconds
}

func TestObserveWorkflowRunCompletion_RecordsTerminalTransition(t *testing.T) {
	t.Parallel()

	observer := &fakeWorkflowRunMetricsObserver{}
	run := db.WorkflowRun{
		ID:        42,
		Status:    "running",
		CreatedAt: time.Now().Add(-5 * time.Second),
	}

	ObserveWorkflowRunCompletion(observer, run, "success")

	require.Equal(t, 1, observer.count)
	assert.Equal(t, "success", observer.status)
	assert.Greater(t, observer.seconds, 0.0)
}

func TestObserveWorkflowRunCompletion_SkipsNonTransitions(t *testing.T) {
	t.Parallel()

	observer := &fakeWorkflowRunMetricsObserver{}
	run := db.WorkflowRun{
		ID:        42,
		Status:    "success",
		CreatedAt: time.Now().Add(-5 * time.Second),
	}

	ObserveWorkflowRunCompletion(observer, run, "success")

	assert.Equal(t, 0, observer.count)
}
