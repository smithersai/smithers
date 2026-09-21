package cleanup

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type workflowCacheCoverStore struct {
	calls int32
}

func (m *workflowCacheCoverStore) Cleanup(ctx context.Context) error {
	atomic.AddInt32(&m.calls, 1)
	return nil
}

func (m *workflowCacheCoverStore) callCount() int {
	return int(atomic.LoadInt32(&m.calls))
}

// TestWorkflowCacheCleaner_Cover_RealTickerDefault exercises the default
// newTicker closure (a *realTicker) that sibling tests always replace.
func TestWorkflowCacheCleaner_Cover_RealTickerDefault(t *testing.T) {
	t.Parallel()

	store := &workflowCacheCoverStore{}
	cleaner := NewWorkflowCacheCleaner(store, 2*time.Millisecond)

	cleaner.Start(context.Background())
	waitForCondition(t, 2*time.Second, func() bool {
		return store.callCount() >= 1
	})

	cleaner.Stop()
	cleaner.Wait()
	require.GreaterOrEqual(t, store.callCount(), 1)
}
