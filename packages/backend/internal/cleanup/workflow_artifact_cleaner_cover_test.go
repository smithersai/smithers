package cleanup

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type workflowArtifactCoverStore struct {
	calls int32
}

func (m *workflowArtifactCoverStore) PruneExpired(ctx context.Context, batchSize int32) (int, error) {
	atomic.AddInt32(&m.calls, 1)
	return 0, nil
}

func (m *workflowArtifactCoverStore) callCount() int {
	return int(atomic.LoadInt32(&m.calls))
}

// TestWorkflowArtifactCleaner_Cover_SweepNilStore covers the nil-store guard in
// sweep, which returns early without calling PruneExpired.
func TestWorkflowArtifactCleaner_Cover_SweepNilStore(t *testing.T) {
	t.Parallel()

	cleaner := NewWorkflowArtifactCleaner(nil, time.Minute, 10)
	// Must not panic.
	cleaner.sweep(context.Background())
}

// TestWorkflowArtifactCleaner_Cover_RealTickerDefault exercises the default
// newTicker closure plus realTicker.Chan/Stop via the loop.
func TestWorkflowArtifactCleaner_Cover_RealTickerDefault(t *testing.T) {
	t.Parallel()

	store := &workflowArtifactCoverStore{}
	cleaner := NewWorkflowArtifactCleaner(store, 2*time.Millisecond, 7)

	cleaner.Start(context.Background())
	waitForCondition(t, 2*time.Second, func() bool {
		return store.callCount() >= 1
	})

	cleaner.Stop()
	cleaner.Wait()
	require.GreaterOrEqual(t, store.callCount(), 1)
}

// TestWorkflowArtifactCleaner_Cover_DoubleStart covers the running-guard early
// return in Start.
func TestWorkflowArtifactCleaner_Cover_DoubleStart(t *testing.T) {
	t.Parallel()

	store := &workflowArtifactCoverStore{}
	ft := &fakeTicker{ch: make(chan time.Time, 1)}
	cleaner := NewWorkflowArtifactCleaner(store, time.Hour, 10)
	cleaner.newTicker = func(time.Duration) ticker { return ft }

	ctx := context.Background()
	cleaner.Start(ctx)
	cleaner.Start(ctx) // no-op

	cleaner.Stop()
	cleaner.Wait()
	assert.Equal(t, 1, ft.StopCalls())
}

// TestWorkflowArtifactCleaner_Cover_ContextCancel covers the ctx.Done() branch
// of the loop, which sibling lifecycle tests (Stop-driven) never take.
func TestWorkflowArtifactCleaner_Cover_ContextCancel(t *testing.T) {
	t.Parallel()

	store := &workflowArtifactCoverStore{}
	ft := &fakeTicker{ch: make(chan time.Time, 1)}
	cleaner := NewWorkflowArtifactCleaner(store, time.Hour, 10)
	cleaner.newTicker = func(time.Duration) ticker { return ft }

	ctx, cancel := context.WithCancel(context.Background())
	cleaner.Start(ctx)
	cancel()
	cleaner.Wait()

	require.GreaterOrEqual(t, ft.StopCalls(), 1)
}

// TestWorkflowArtifactCleaner_Cover_StopWithoutStart covers Stop's not-running
// early return.
func TestWorkflowArtifactCleaner_Cover_StopWithoutStart(t *testing.T) {
	t.Parallel()

	cleaner := NewWorkflowArtifactCleaner(&workflowArtifactCoverStore{}, time.Hour, 10)
	cleaner.Stop()
}
