package clusterservices

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
)

type queueTimeoutStoreStub struct {
	runs   []clusterdb.ListExpiredQueuedRunnerWorkflowRunsRow
	marked map[int64]int64
	calls  []int64
}

func (s *queueTimeoutStoreStub) ListExpiredQueuedRunnerWorkflowRuns(_ context.Context, limit int32) ([]clusterdb.ListExpiredQueuedRunnerWorkflowRunsRow, error) {
	if limit != runnerQueueTimeoutSweepLimit {
		return nil, errors.New("unbounded timeout sweep")
	}
	return s.runs, nil
}

func (s *queueTimeoutStoreStub) MarkQueuedRunnerWorkflowRunTimeout(_ context.Context, arg clusterdb.MarkQueuedRunnerWorkflowRunTimeoutParams) (int64, error) {
	s.calls = append(s.calls, arg.RunID)
	return s.marked[arg.RunID], nil
}

type queueTimeoutCancellerStub struct{ calls []int64 }

func (c *queueTimeoutCancellerStub) CancelRun(_ context.Context, _, runID int64) error {
	c.calls = append(c.calls, runID)
	return nil
}

func TestRunnerQueueTimeoutWorker_OnlyCancelsMarkedRuns(t *testing.T) {
	store := &queueTimeoutStoreStub{
		runs:   []clusterdb.ListExpiredQueuedRunnerWorkflowRunsRow{{ID: 11, RepositoryID: 1}, {ID: 12, RepositoryID: 2}},
		marked: map[int64]int64{11: 1},
	}
	canceller := &queueTimeoutCancellerStub{}
	require.NoError(t, NewRunnerQueueTimeoutWorker(store, canceller).PollOnce(context.Background()))
	assert.Equal(t, []int64{11, 12}, store.calls)
	assert.Equal(t, []int64{11}, canceller.calls, "a run claimed or cancelled by another worker stays untouched")
}
