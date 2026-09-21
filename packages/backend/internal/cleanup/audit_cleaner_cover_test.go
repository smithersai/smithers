package cleanup

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// auditCoverStore is a thread-safe AuditCleanupStore for concurrent (real
// ticker) lifecycle tests.
type auditCoverStore struct {
	calls int32
}

func (m *auditCoverStore) DeleteAuditLogsOlderThan(ctx context.Context, createdAt time.Time) error {
	atomic.AddInt32(&m.calls, 1)
	return nil
}

func (m *auditCoverStore) callCount() int {
	return int(atomic.LoadInt32(&m.calls))
}

// TestAuditCleaner_Cover_RealTickerDefault exercises the default newTicker
// closure (a *realTicker), which every other test replaces with a fake. This
// covers NewAuditCleaner's closure body plus realTicker.Chan/Stop via the loop.
func TestAuditCleaner_Cover_RealTickerDefault(t *testing.T) {
	t.Parallel()

	store := &auditCoverStore{}
	cleaner := NewAuditCleaner(store, 2*time.Millisecond, 90*24*time.Hour)

	cleaner.Start(context.Background())
	waitForCondition(t, 2*time.Second, func() bool {
		return store.callCount() >= 1
	})

	cleaner.Stop()
	cleaner.Wait()
	require.GreaterOrEqual(t, store.callCount(), 1)
}

// TestAuditCleaner_Cover_WaitReturnsWhenIdle verifies Wait on a never-started
// cleaner returns immediately (WaitGroup counter is zero).
func TestAuditCleaner_Cover_WaitReturnsWhenIdle(t *testing.T) {
	t.Parallel()

	store := &auditCoverStore{}
	cleaner := NewAuditCleaner(store, time.Hour, time.Hour)

	done := make(chan struct{})
	go func() {
		cleaner.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Wait did not return for an idle cleaner")
	}
	assert.Equal(t, 0, store.callCount())
}
