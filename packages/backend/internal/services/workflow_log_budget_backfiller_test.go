package services

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type workflowLogBudgetBackfillResult struct {
	runID int64
	err   error
}

type fakeWorkflowLogBudgetBackfillQuerier struct {
	mu      sync.Mutex
	results []workflowLogBudgetBackfillResult
	calls   int
}

func (q *fakeWorkflowLogBudgetBackfillQuerier) BackfillOneWorkflowLogBudget(context.Context) (int64, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.calls++
	if len(q.results) == 0 {
		return 0, pgx.ErrNoRows
	}
	result := q.results[0]
	q.results = q.results[1:]
	return result.runID, result.err
}

func TestWorkflowLogBudgetBackfillerPollOnce(t *testing.T) {
	w := NewWorkflowLogBudgetBackfiller(&fakeWorkflowLogBudgetBackfillQuerier{results: []workflowLogBudgetBackfillResult{
		{runID: 42},
		{err: pgx.ErrNoRows},
		{err: errors.New("database unavailable")},
	}})

	processed, err := w.PollOnce(context.Background())
	require.NoError(t, err)
	assert.True(t, processed)

	processed, err = w.PollOnce(context.Background())
	require.NoError(t, err)
	assert.False(t, processed)

	processed, err = w.PollOnce(context.Background())
	assert.False(t, processed)
	assert.ErrorContains(t, err, "database unavailable")
}

func TestWorkflowLogBudgetBackfillerStartStopsAndResumesAfterIdle(t *testing.T) {
	q := &fakeWorkflowLogBudgetBackfillQuerier{results: []workflowLogBudgetBackfillResult{
		{runID: 7},
		{err: pgx.ErrNoRows},
	}}
	w := NewWorkflowLogBudgetBackfiller(q)
	w.activeInterval = time.Millisecond
	w.idleInterval = time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		w.Start(ctx)
	}()

	require.Eventually(t, func() bool {
		q.mu.Lock()
		defer q.mu.Unlock()
		return q.calls >= 2
	}, time.Second, time.Millisecond)
	cancel()
	require.Eventually(t, func() bool {
		select {
		case <-done:
			return true
		default:
			return false
		}
	}, time.Second, time.Millisecond)
}

func TestWorkflowLogBudgetBackfillerNilIsIdle(t *testing.T) {
	processed, err := (*WorkflowLogBudgetBackfiller)(nil).PollOnce(context.Background())
	require.NoError(t, err)
	assert.False(t, processed)
}
