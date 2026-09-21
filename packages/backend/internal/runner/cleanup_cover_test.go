package runner

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestCleanup_Cov_ListStaleRunnersError(t *testing.T) {
	t.Parallel()

	listErr := errors.New("list stale failed")
	baseNow := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	store := &mockStore{
		listStaleRunnersFn: func(_ context.Context, cutoffAt pgtype.Timestamptz) ([]db.RunnerPool, error) {
			assert.True(t, cutoffAt.Valid)
			assert.Equal(t, baseNow.Add(-30*time.Second), cutoffAt.Time)
			return nil, listErr
		},
		terminateRunnerFn: func(context.Context, int64) (db.RunnerPool, error) {
			require.Fail(t, "terminate runner should not run when listing stale runners fails")
			return db.RunnerPool{}, nil
		},
	}

	pool := NewRunnerPool(store, Config{HeartbeatTimeout: 30 * time.Second})
	pool.now = func() time.Time { return baseNow }

	cleaned, err := pool.cleanupStaleRunners(context.Background())
	require.ErrorIs(t, err, listErr)
	assert.Equal(t, 0, cleaned)
}
