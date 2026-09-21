package cleanup

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type sandboxEgressAuditCleanupStore struct {
	retentionDays chan int64
}

func (s *sandboxEgressAuditCleanupStore) DeleteSandboxEgressAuditOlderThan(_ context.Context, retentionDays int64) (int64, error) {
	s.retentionDays <- retentionDays
	return 2, nil
}

func TestSandboxEgressAuditCleanerUsesConfiguredRetention(t *testing.T) {
	store := &sandboxEgressAuditCleanupStore{retentionDays: make(chan int64, 1)}
	cleaner := NewSandboxEgressAuditCleaner(store, time.Millisecond, 17)
	cleaner.Start(context.Background())
	t.Cleanup(cleaner.Stop)

	select {
	case retentionDays := <-store.retentionDays:
		assert.Equal(t, int64(17), retentionDays)
	case <-time.After(time.Second):
		require.Fail(t, "timed out waiting for sandbox egress audit cleanup")
	}
}
