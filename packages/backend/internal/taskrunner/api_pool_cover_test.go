package taskrunner

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	runnerclient "github.com/smithersai/smithers/packages/backend/internal/taskrunner/client"
)

func TestAPIPool_Cov_UnavailableClient(t *testing.T) {
	t.Parallel()

	task, err := (*APIPool)(nil).ClaimTask(context.Background(), 1)
	require.Error(t, err)
	assert.Nil(t, task)
	assert.EqualError(t, err, "runner API client unavailable")

	err = NewAPIPool(nil).CompleteTask(context.Background(), 10, 1, "done", "")
	require.Error(t, err)
	assert.EqualError(t, err, "runner API client unavailable")
}

func TestAPIPool_Cov_ClaimTaskNilTask(t *testing.T) {
	t.Parallel()

	pool := NewAPIPool(&mockAPITaskClient{
		claimTaskFn: func(_ context.Context, runnerID int64) (*runnerclient.Task, error) {
			assert.Equal(t, int64(44), runnerID)
			return nil, nil
		},
	})

	task, err := pool.ClaimTask(context.Background(), 44)
	require.NoError(t, err)
	assert.Nil(t, task)
}

func TestAPIPool_Cov_CompleteTaskPropagatesError(t *testing.T) {
	t.Parallel()

	completeErr := errors.New("complete failed")
	pool := NewAPIPool(&mockAPITaskClient{
		completeTaskFn: func(_ context.Context, taskID, runnerID int64, status, errorMessage string) error {
			assert.Equal(t, int64(15), taskID)
			assert.Equal(t, int64(6), runnerID)
			assert.Equal(t, "failed", status)
			assert.Equal(t, "exit status 1", errorMessage)
			return completeErr
		},
	})

	err := pool.CompleteTask(context.Background(), 15, 6, "failed", "exit status 1")
	require.ErrorIs(t, err, completeErr)
}
