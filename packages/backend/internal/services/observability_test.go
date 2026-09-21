package services

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type fakeRuntimeMetricsStore struct {
	idle           int64
	busy           int64
	activeSessions int64
	oldestSession  float64
	queueDepth     int64
	queueAge       float64
}

func (f *fakeRuntimeMetricsStore) CountRunners(_ context.Context, statusFilter string) (int64, error) {
	switch statusFilter {
	case "idle":
		return f.idle, nil
	case "busy":
		return f.busy, nil
	default:
		return 0, nil
	}
}

func (f *fakeRuntimeMetricsStore) CountActiveAgentSessions(context.Context) (int64, error) {
	return f.activeSessions, nil
}

func (f *fakeRuntimeMetricsStore) GetActiveAgentSessionOldestAgeSeconds(context.Context) (float64, error) {
	return f.oldestSession, nil
}

func (f *fakeRuntimeMetricsStore) GetWorkflowTaskQueueMetrics(context.Context) (WorkflowTaskQueueMetrics, error) {
	return WorkflowTaskQueueMetrics{
		Depth:            f.queueDepth,
		OldestAgeSeconds: f.queueAge,
	}, nil
}

type fakeRuntimeMetricsObserver struct {
	mu               sync.Mutex
	runnerAvailable  float64
	runnerClaimed    float64
	activeAgentGauge float64
	oldestSessionAge float64
	queueDepth       float64
	queueAge         float64
	landingDepth     float64
}

func (f *fakeRuntimeMetricsObserver) SetRunnerPoolAvailable(n float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.runnerAvailable = n
}

func (f *fakeRuntimeMetricsObserver) SetRunnerPoolClaimed(n float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.runnerClaimed = n
}

func (f *fakeRuntimeMetricsObserver) SetActiveAgentSessions(n float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.activeAgentGauge = n
}

func (f *fakeRuntimeMetricsObserver) SetActiveAgentSessionOldestAgeSeconds(n float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.oldestSessionAge = n
}

func (f *fakeRuntimeMetricsObserver) SetWorkflowTaskQueueDepth(n float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.queueDepth = n
}

func (f *fakeRuntimeMetricsObserver) SetWorkflowTaskQueueOldestAgeSeconds(n float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.queueAge = n
}

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

func TestStartRuntimeMetricsCollector_CollectsCurrentState(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	store := &fakeRuntimeMetricsStore{
		idle:           4,
		busy:           2,
		activeSessions: 7,
		oldestSession:  1860,
		queueDepth:     3,
		queueAge:       91,
	}
	observer := &fakeRuntimeMetricsObserver{}

	StartRuntimeMetricsCollector(ctx, store, observer, 50*time.Millisecond)

	require.Eventually(t, func() bool {
		observer.mu.Lock()
		defer observer.mu.Unlock()
		return observer.runnerAvailable == 4 &&
			observer.runnerClaimed == 2 &&
			observer.activeAgentGauge == 7 &&
			observer.oldestSessionAge == 1860 &&
			observer.queueDepth == 3 &&
			observer.queueAge == 91 && observer.landingDepth == 7
	}, time.Second, 10*time.Millisecond)
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

func (f *fakeRuntimeMetricsStore) GetLandingQueueDepth(context.Context) (int64, error) { return 7, nil }

func (f *fakeRuntimeMetricsObserver) SetLandingQueueDepth(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.landingDepth = float64(n)
}

type blockingLandingMetricsStore struct {
	fakeRuntimeMetricsStore
	polls     atomic.Int64
	cancelled chan error
}

func (s *blockingLandingMetricsStore) CountActiveAgentSessions(context.Context) (int64, error) {
	return s.polls.Add(1), nil
}
func (s *blockingLandingMetricsStore) GetLandingQueueDepth(ctx context.Context) (int64, error) {
	<-ctx.Done()
	s.cancelled <- ctx.Err()
	return 0, ctx.Err()
}

func TestStartRuntimeMetricsCollector_BlockedLandingDoesNotFreezeOtherGauges(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store := &blockingLandingMetricsStore{fakeRuntimeMetricsStore: fakeRuntimeMetricsStore{idle: 4, busy: 2, queueDepth: 9}, cancelled: make(chan error, 100)}
	observer := &fakeRuntimeMetricsObserver{landingDepth: 17}
	startRuntimeMetricsCollector(ctx, store, observer, 10*time.Millisecond, 100*time.Millisecond)
	for i := 0; i < 2; i++ {
		select {
		case err := <-store.cancelled:
			require.ErrorIs(t, err, context.DeadlineExceeded)
		case <-time.After(time.Second):
			t.Fatal("landing refresh did not reach its deadline or polling stopped")
		}
	}
	observer.mu.Lock()
	defer observer.mu.Unlock()
	require.Equal(t, 4.0, observer.runnerAvailable)
	require.Equal(t, 2.0, observer.runnerClaimed)
	require.GreaterOrEqual(t, observer.activeAgentGauge, 2.0)
	require.Equal(t, 9.0, observer.queueDepth)
	require.Equal(t, 17.0, observer.landingDepth, "failed query must not publish a false zero")
}
