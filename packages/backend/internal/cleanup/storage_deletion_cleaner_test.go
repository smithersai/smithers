package cleanup

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type fakeStorageDeletionCoordinator struct {
	rows         []db.StorageDeletionQueue
	active       map[int64]bool
	claimErr     error
	claimedLease time.Duration
	processed    []int64
	retryCounts  map[int64]int
}

func (f *fakeStorageDeletionCoordinator) Claim(_ context.Context, token string, lease time.Duration, limit int32) ([]db.StorageDeletionQueue, error) {
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	f.claimedLease = lease
	if int(limit) < len(f.rows) {
		f.rows = f.rows[:limit]
	}
	for i := range f.rows {
		f.rows[i].ClaimToken = pgtype.Text{String: token, Valid: true}
	}
	return append([]db.StorageDeletionQueue(nil), f.rows...), nil
}

func (f *fakeStorageDeletionCoordinator) Process(ctx context.Context, row db.StorageDeletionQueue, purge func(context.Context, string) error) (bool, error) {
	if f.active[row.ID] {
		f.processed = append(f.processed, row.ID)
		return true, nil
	}
	if err := purge(ctx, row.ObjectKey); err != nil {
		if f.retryCounts == nil {
			f.retryCounts = make(map[int64]int)
		}
		f.retryCounts[row.ID]++
		return false, err
	}
	f.processed = append(f.processed, row.ID)
	return true, nil
}

type recordingGenerationPurger struct {
	blob.Store
	keys []string
	fail map[string]error
}

type blockingGenerationPurger struct{ blob.Store }

func (blockingGenerationPurger) PurgeAllGenerations(ctx context.Context, _ string) error {
	<-ctx.Done()
	return ctx.Err()
}

func (s *recordingGenerationPurger) PurgeAllGenerations(_ context.Context, key string) error {
	s.keys = append(s.keys, key)
	return s.fail[key]
}

func TestStorageDeletionCleanerFailureRetainsRetryAndContinues(t *testing.T) {
	t.Parallel()
	wantErr := errors.New("gcs unavailable")
	coordinator := &fakeStorageDeletionCoordinator{rows: []db.StorageDeletionQueue{
		{ID: 1, ObjectKey: "failed"},
		{ID: 2, ObjectKey: "succeeds"},
	}}
	store := &recordingGenerationPurger{fail: map[string]error{"failed": wantErr}}
	cleaner := newStorageDeletionCleaner(coordinator, store, time.Minute, 10)

	processed, err := cleaner.sweep(context.Background())
	require.ErrorIs(t, err, wantErr)
	assert.Equal(t, 1, processed)
	assert.Equal(t, []string{"failed", "succeeds"}, store.keys)
	assert.Equal(t, storageDeletionClaimLease, coordinator.claimedLease)
	assert.Equal(t, 1, coordinator.retryCounts[1], "failed claim remains retryable and metered")
	assert.Equal(t, []int64{2}, coordinator.processed)
}

func TestStorageDeletionCleanerPreservesActiveLFSKey(t *testing.T) {
	t.Parallel()
	coordinator := &fakeStorageDeletionCoordinator{
		rows:   []db.StorageDeletionQueue{{ID: 7, ObjectKey: "repos/42/lfs/abc"}},
		active: map[int64]bool{7: true},
	}
	store := &recordingGenerationPurger{}
	cleaner := newStorageDeletionCleaner(coordinator, store, time.Minute, 10)

	processed, err := cleaner.sweep(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 1, processed)
	assert.Empty(t, store.keys, "active deterministic LFS bytes must never be purged")
	assert.Equal(t, []int64{7}, coordinator.processed)
}

func TestStorageDeletionCleanerClaimFailure(t *testing.T) {
	t.Parallel()
	wantErr := errors.New("database unavailable")
	cleaner := newStorageDeletionCleaner(
		&fakeStorageDeletionCoordinator{claimErr: wantErr},
		&recordingGenerationPurger{},
		0,
		0,
	)
	assert.Equal(t, defaultStorageDeletionInterval, cleaner.interval)
	assert.Equal(t, int32(250), cleaner.batchSize)
	processed, err := cleaner.sweep(context.Background())
	assert.Zero(t, processed)
	require.ErrorIs(t, err, wantErr)
}

func TestStorageDeletionCleanerBoundsPerObjectPurge(t *testing.T) {
	t.Parallel()
	coordinator := &fakeStorageDeletionCoordinator{rows: []db.StorageDeletionQueue{{ID: 9, ObjectKey: "slow/key"}}}
	cleaner := newStorageDeletionCleaner(coordinator, blockingGenerationPurger{}, time.Minute, 1)
	cleaner.purgeTimeout = 10 * time.Millisecond

	started := time.Now()
	processed, err := cleaner.sweep(context.Background())
	assert.Zero(t, processed)
	require.ErrorIs(t, err, context.DeadlineExceeded)
	assert.Less(t, time.Since(started), time.Second)
	assert.Equal(t, 1, coordinator.retryCounts[9], "timeout releases the durable claim for retry")
}
