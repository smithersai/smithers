package runner

import (
	"context"
	"errors"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHeartbeat_Cov_PublicWrapperPropagatesError(t *testing.T) {
	t.Parallel()

	heartbeatErr := errors.New("heartbeat failed")
	store := &mockStore{
		touchRunnerHeartbeat: func(_ context.Context, runnerID int64) (clusterdb.RunnerPool, error) {
			assert.Equal(t, int64(55), runnerID)
			return clusterdb.RunnerPool{}, heartbeatErr
		},
	}

	pool := NewRunnerPool(store, Config{})
	err := pool.Heartbeat(context.Background(), 55)
	require.ErrorIs(t, err, heartbeatErr)
}
