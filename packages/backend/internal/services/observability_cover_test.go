package services

import (
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func TestObservability_Cov_StartedAtDurationBranch(t *testing.T) {
	observer := &fakeWorkflowRunMetricsObserver{}
	run := db.WorkflowRun{
		ID:        101,
		Status:    "running",
		CreatedAt: time.Now().Add(-10 * time.Second),
		StartedAt: pgtype.Timestamptz{Time: time.Now().Add(-2 * time.Second), Valid: true},
	}

	ObserveWorkflowRunCompletion(observer, run, "failed")
	require.Equal(t, 0, observer.count)

	ObserveWorkflowRunCompletion(observer, run, "failure")
	require.Equal(t, 1, observer.count)
	assert.Equal(t, "failure", observer.status)
	assert.Less(t, observer.seconds, 5.0)
}

func TestObserveWorkflowRunCompletionFutureCreation(t *testing.T) {
	observer := &fakeWorkflowRunMetricsObserver{}
	ObserveWorkflowRunCompletion(observer, db.WorkflowRun{ID: 99, Status: "running", CreatedAt: time.Now().Add(time.Hour)}, "success")
	assert.Equal(t, 0, observer.count)
}
