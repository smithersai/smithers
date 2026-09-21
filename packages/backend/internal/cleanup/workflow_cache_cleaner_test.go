package cleanup

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockWorkflowCacheCleanupStore struct {
	cleanupFn func(ctx context.Context) error
	calls     int32
}

func (m *mockWorkflowCacheCleanupStore) Cleanup(ctx context.Context) error {
	atomic.AddInt32(&m.calls, 1)
	if m.cleanupFn != nil {
		return m.cleanupFn(ctx)
	}
	return nil
}

func (m *mockWorkflowCacheCleanupStore) callCount() int {
	return int(atomic.LoadInt32(&m.calls))
}

func TestWorkflowCacheCleaner_Sweep_CallsStore(t *testing.T) {
	t.Parallel()

	store := &mockWorkflowCacheCleanupStore{}
	cleaner := NewWorkflowCacheCleaner(store, time.Hour)
	cleaner.sweep(context.Background())

	assert.Equal(t, 1, store.callCount())
}

func TestWorkflowCacheCleaner_Sweep_HandleError(t *testing.T) {
	t.Parallel()

	store := &mockWorkflowCacheCleanupStore{
		cleanupFn: func(ctx context.Context) error {
			return errors.New("cleanup failed")
		},
	}
	cleaner := NewWorkflowCacheCleaner(store, time.Hour)

	// Should not panic on error
	cleaner.sweep(context.Background())
	assert.Equal(t, 1, store.callCount())
}

func TestWorkflowCacheCleaner_StartAndStop(t *testing.T) {
	t.Parallel()

	store := &mockWorkflowCacheCleanupStore{}
	ft := &fakeTicker{ch: make(chan time.Time, 1)}
	cleaner := NewWorkflowCacheCleaner(store, time.Hour)
	cleaner.newTicker = func(d time.Duration) ticker { return ft }

	ctx := context.Background()
	cleaner.Start(ctx)

	// Trigger one tick
	ft.ch <- time.Now()
	waitForCondition(t, time.Second, func() bool {
		return store.callCount() >= 1
	})

	cleaner.Stop()
	cleaner.Wait()
	assert.GreaterOrEqual(t, store.callCount(), 1)
}

func TestWorkflowCacheCleaner_DoubleStart(t *testing.T) {
	t.Parallel()

	store := &mockWorkflowCacheCleanupStore{}
	ft := &fakeTicker{ch: make(chan time.Time, 1)}
	cleaner := NewWorkflowCacheCleaner(store, time.Hour)
	cleaner.newTicker = func(d time.Duration) ticker { return ft }

	ctx := context.Background()
	cleaner.Start(ctx)
	cleaner.Start(ctx) // Second start should be a no-op

	cleaner.Stop()
	cleaner.Wait()
}

func TestWorkflowCacheCleaner_StopWithoutStart(t *testing.T) {
	t.Parallel()

	store := &mockWorkflowCacheCleanupStore{}
	cleaner := NewWorkflowCacheCleaner(store, time.Hour)

	// Should not panic
	cleaner.Stop()
}

func TestWorkflowCacheCleaner_ContextCancellation(t *testing.T) {
	t.Parallel()

	store := &mockWorkflowCacheCleanupStore{}
	ft := &fakeTicker{ch: make(chan time.Time, 1)}
	cleaner := NewWorkflowCacheCleaner(store, time.Hour)
	cleaner.newTicker = func(d time.Duration) ticker { return ft }

	ctx, cancel := context.WithCancel(context.Background())
	cleaner.Start(ctx)
	cancel()
	cleaner.Wait()

	require.GreaterOrEqual(t, ft.StopCalls(), 1)
}
