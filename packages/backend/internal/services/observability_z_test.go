package services

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type observabilityZQuerier struct {
	err error
}

func (q observabilityZQuerier) CountRunners(context.Context, string) (int64, error) {
	return 0, nil
}

func (q observabilityZQuerier) GetClaimableWorkflowTaskBacklog(context.Context) (db.GetClaimableWorkflowTaskBacklogRow, error) {
	return db.GetClaimableWorkflowTaskBacklogRow{}, q.err
}

type observabilityZStore struct {
	mu          sync.Mutex
	fail        string
	idleCalls   int
	calls       chan string
	tickFail    bool
	tickFailSet bool
}

func (s *observabilityZStore) record(name string) {
	select {
	case s.calls <- name:
	default:
	}
}

func (s *observabilityZStore) CountRunners(context.Context, string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.idleCalls++
	s.record("runner")
	if s.fail == "runner" || (s.tickFail && s.idleCalls > 1) {
		return 0, errors.New("runner failed")
	}
	return 1, nil
}

func (s *observabilityZStore) CountActiveAgentSessions(context.Context) (int64, error) {
	s.record("sessions")
	if s.fail == "sessions" {
		return 0, errors.New("sessions failed")
	}
	return 1, nil
}

func (s *observabilityZStore) GetActiveAgentSessionOldestAgeSeconds(context.Context) (float64, error) {
	s.record("oldest")
	if s.fail == "oldest" {
		return 0, errors.New("oldest failed")
	}
	return 1, nil
}

func (s *observabilityZStore) GetWorkflowTaskQueueMetrics(context.Context) (WorkflowTaskQueueMetrics, error) {
	s.record("queue")
	if s.fail == "queue" {
		return WorkflowTaskQueueMetrics{}, errors.New("queue failed")
	}
	return WorkflowTaskQueueMetrics{Depth: 1}, nil
}

func TestObservability_Z_ErrorBranches(t *testing.T) {
	_, err := (&dbRuntimeMetricsStore{queries: observabilityZQuerier{err: errors.New("backlog failed")}}).GetWorkflowTaskQueueMetrics(context.Background())
	require.Error(t, err)

	for _, fail := range []string{"runner", "sessions", "oldest", "queue"} {
		ctx, cancel := context.WithCancel(context.Background())
		store := &observabilityZStore{fail: fail, calls: make(chan string, 8)}
		StartRuntimeMetricsCollector(ctx, store, &fakeRuntimeMetricsObserver{}, time.Hour)
		require.Eventually(t, func() bool {
			return len(store.calls) > 0
		}, time.Second, time.Millisecond)
		cancel()
	}

	ctx, cancel := context.WithCancel(context.Background())
	store := &observabilityZStore{calls: make(chan string, 16), tickFail: true}
	StartRuntimeMetricsCollector(ctx, store, &fakeRuntimeMetricsObserver{}, time.Millisecond)
	require.Eventually(t, func() bool {
		store.mu.Lock()
		defer store.mu.Unlock()
		return store.idleCalls > 1
	}, time.Second, time.Millisecond)
	cancel()
}

func (f *observabilityZStore) GetLandingQueueDepth(context.Context) (int64, error) { return 7, nil }

func (q observabilityZQuerier) GetLandingQueueDepth(context.Context) (int64, error) { return 0, q.err }
