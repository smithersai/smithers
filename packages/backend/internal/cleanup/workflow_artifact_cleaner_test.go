package cleanup

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

type mockWorkflowArtifactCleanupStore struct {
	mu      sync.Mutex
	calls   []int32
	pruneFn func(ctx context.Context, batchSize int32) (int, error)
}

func (m *mockWorkflowArtifactCleanupStore) PruneExpired(ctx context.Context, batchSize int32) (int, error) {
	m.mu.Lock()
	m.calls = append(m.calls, batchSize)
	m.mu.Unlock()
	if m.pruneFn != nil {
		return m.pruneFn(ctx, batchSize)
	}
	return 0, nil
}

func (m *mockWorkflowArtifactCleanupStore) callSnapshot() []int32 {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]int32, len(m.calls))
	copy(out, m.calls)
	return out
}

func TestWorkflowArtifactCleanerSweep_CallsPrune(t *testing.T) {
	t.Parallel()

	store := &mockWorkflowArtifactCleanupStore{}
	cleaner := NewWorkflowArtifactCleaner(store, time.Minute, 25)
	cleaner.sweep(context.Background())

	assert.Equal(t, []int32{25}, store.callSnapshot())
}

func TestWorkflowArtifactCleanerLifecycle_TickerRunsSweep(t *testing.T) {
	t.Parallel()

	store := &mockWorkflowArtifactCleanupStore{}
	cleaner := NewWorkflowArtifactCleaner(store, time.Hour, 10)

	ft := &fakeTicker{ch: make(chan time.Time, 1)}
	cleaner.newTicker = func(time.Duration) ticker {
		return ft
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cleaner.Start(ctx)
	ft.ch <- time.Now()

	waitForCondition(t, 500*time.Millisecond, func() bool {
		return len(store.callSnapshot()) == 1
	})

	cleaner.Stop()
	cleaner.Wait()

	assert.Equal(t, []int32{10}, store.callSnapshot())
	assert.Equal(t, 1, ft.StopCalls())
}

func TestWorkflowArtifactCleanerSweep_IgnoresStoreErrors(t *testing.T) {
	t.Parallel()

	store := &mockWorkflowArtifactCleanupStore{
		pruneFn: func(ctx context.Context, batchSize int32) (int, error) {
			return 0, errors.New("boom")
		},
	}
	cleaner := NewWorkflowArtifactCleaner(store, time.Minute, 5)
	cleaner.sweep(context.Background())

	assert.Equal(t, []int32{5}, store.callSnapshot())
}
