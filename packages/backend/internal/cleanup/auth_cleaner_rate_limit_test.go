package cleanup

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type rateLimitCleanupStore struct {
	*mockCleanupStore
	cutoffs []time.Time
	err     error
}

func (s *rateLimitCleanupStore) DeleteExpiredSearchRateLimits(_ context.Context, cutoffAt time.Time) error {
	s.cutoffs = append(s.cutoffs, cutoffAt)
	return s.err
}

// Expired rate-limit buckets are pruned by the periodic auth sweep, once per
// process, rather than inline on whichever user request wins a race.
func TestAuthCleanerSweep_PrunesExpiredRateLimitBuckets(t *testing.T) {
	t.Parallel()

	store := &rateLimitCleanupStore{mockCleanupStore: &mockCleanupStore{}}
	cleaner := NewAuthCleaner(store, time.Minute)
	require.NoError(t, cleaner.sweep(context.Background()))
	require.Len(t, store.cutoffs, 1)
	assert.WithinDuration(t, time.Now().Add(-rateLimitBucketRetention), store.cutoffs[0], time.Minute)

	store.err = errors.New("lock timeout")
	err := cleaner.sweep(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "delete expired rate limit buckets")
}
