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

type mockAuditCleanupStore struct {
	deleteFn func(ctx context.Context, createdAt time.Time) error
	calls    int32
}

func (m *mockAuditCleanupStore) DeleteAuditLogsOlderThan(ctx context.Context, createdAt time.Time) error {
	atomic.AddInt32(&m.calls, 1)
	if m.deleteFn != nil {
		return m.deleteFn(ctx, createdAt)
	}
	return nil
}

func (m *mockAuditCleanupStore) callCount() int {
	return int(atomic.LoadInt32(&m.calls))
}

func TestAuditCleaner_Sweep_CallsStore(t *testing.T) {
	t.Parallel()

	store := &mockAuditCleanupStore{}
	cleaner := NewAuditCleaner(store, time.Hour, 90*24*time.Hour)
	cleaner.sweep(context.Background())

	assert.Equal(t, 1, store.callCount())
}

func TestAuditCleaner_Sweep_HandleError(t *testing.T) {
	t.Parallel()

	store := &mockAuditCleanupStore{
		deleteFn: func(ctx context.Context, createdAt time.Time) error {
			return errors.New("db error")
		},
	}
	cleaner := NewAuditCleaner(store, time.Hour, 90*24*time.Hour)

	// Should not panic on error
	cleaner.sweep(context.Background())
	assert.Equal(t, 1, store.callCount())
}

func TestAuditCleaner_StartAndStop(t *testing.T) {
	t.Parallel()

	store := &mockAuditCleanupStore{}
	ft := &fakeTicker{ch: make(chan time.Time, 1)}
	cleaner := NewAuditCleaner(store, time.Hour, 90*24*time.Hour)
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

func TestAuditCleaner_DoubleStart(t *testing.T) {
	t.Parallel()

	store := &mockAuditCleanupStore{}
	ft := &fakeTicker{ch: make(chan time.Time, 1)}
	cleaner := NewAuditCleaner(store, time.Hour, 90*24*time.Hour)
	cleaner.newTicker = func(d time.Duration) ticker { return ft }

	ctx := context.Background()
	cleaner.Start(ctx)
	cleaner.Start(ctx) // Second start should be a no-op

	cleaner.Stop()
	cleaner.Wait()
}

func TestAuditCleaner_StopWithoutStart(t *testing.T) {
	t.Parallel()

	store := &mockAuditCleanupStore{}
	cleaner := NewAuditCleaner(store, time.Hour, 90*24*time.Hour)

	// Should not panic
	cleaner.Stop()
}

func TestAuditCleaner_ContextCancellation(t *testing.T) {
	t.Parallel()

	store := &mockAuditCleanupStore{}
	ft := &fakeTicker{ch: make(chan time.Time, 1)}
	cleaner := NewAuditCleaner(store, time.Hour, 90*24*time.Hour)
	cleaner.newTicker = func(d time.Duration) ticker { return ft }

	ctx, cancel := context.WithCancel(context.Background())
	cleaner.Start(ctx)
	cancel()
	cleaner.Wait()

	require.GreaterOrEqual(t, ft.StopCalls(), 1)
}

func TestAuditCleaner_RetentionApplied(t *testing.T) {
	t.Parallel()

	var cutoffSeen time.Time
	store := &mockAuditCleanupStore{
		deleteFn: func(ctx context.Context, createdAt time.Time) error {
			cutoffSeen = createdAt
			return nil
		},
	}
	retention := 30 * 24 * time.Hour
	cleaner := NewAuditCleaner(store, time.Hour, retention)
	cleaner.sweep(context.Background())

	expected := time.Now().Add(-retention)
	assert.WithinDuration(t, expected, cutoffSeen, 2*time.Second)
}
