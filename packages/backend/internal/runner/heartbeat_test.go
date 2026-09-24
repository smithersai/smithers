package runner

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
)

func TestRunnerPool_heartbeatRunner_Success(t *testing.T) {
	t.Parallel()

	var touchedRunnerID int64
	store := &mockStore{
		touchRunnerHeartbeat: func(_ context.Context, id int64) (clusterdb.RunnerPool, error) {
			touchedRunnerID = id
			return clusterdb.RunnerPool{ID: id, Status: "busy"}, nil
		},
	}

	pool := NewRunnerPool(store, Config{})
	err := pool.heartbeatRunner(context.Background(), 41)
	require.NoError(t, err)
	assert.Equal(t, int64(41), touchedRunnerID)
}

func TestRunnerPool_heartbeatRunner_RunnerNotFound(t *testing.T) {
	t.Parallel()

	store := &mockStore{
		touchRunnerHeartbeat: func(_ context.Context, _ int64) (clusterdb.RunnerPool, error) {
			return clusterdb.RunnerPool{}, pgx.ErrNoRows
		},
	}

	pool := NewRunnerPool(store, Config{})
	err := pool.heartbeatRunner(context.Background(), 999)
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}
