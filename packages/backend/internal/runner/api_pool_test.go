package runner

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	runnerclient "github.com/smithersai/smithers/packages/backend/internal/runner/client"
)

type mockAPITaskClient struct {
	claimTaskFn    func(ctx context.Context, runnerID int64) (*runnerclient.Task, error)
	completeTaskFn func(ctx context.Context, taskID, runnerID int64, status, errorMessage string) error
}

func (m *mockAPITaskClient) ClaimTask(ctx context.Context, runnerID int64) (*runnerclient.Task, error) {
	if m.claimTaskFn != nil {
		return m.claimTaskFn(ctx, runnerID)
	}
	return nil, nil
}

func (m *mockAPITaskClient) CompleteTask(ctx context.Context, taskID, runnerID int64, status, errorMessage string) error {
	if m.completeTaskFn != nil {
		return m.completeTaskFn(ctx, taskID, runnerID, status, errorMessage)
	}
	return nil
}

func TestAPIPool_ClaimTask(t *testing.T) {
	t.Parallel()

	pool := NewAPIPool(&mockAPITaskClient{
		claimTaskFn: func(ctx context.Context, runnerID int64) (*runnerclient.Task, error) {
			assert.Equal(t, int64(8), runnerID)
			return &runnerclient.Task{
				ID:             9,
				WorkflowRunID:  10,
				RepositoryID:   11,
				WorkflowStepID: 12,
				Attempt:        3,
				Payload:        json.RawMessage(`{"job":"build"}`),
			}, nil
		},
	})

	task, err := pool.ClaimTask(context.Background(), 8)
	require.NoError(t, err)
	require.NotNil(t, task)
	assert.Equal(t, int64(11), task.RepositoryID)
	assert.Equal(t, int64(12), task.WorkflowStepID)
	assert.Equal(t, int32(3), task.Attempt)
}

func TestAPIPool_ClaimTask_PropagatesErrors(t *testing.T) {
	t.Parallel()

	pool := NewAPIPool(&mockAPITaskClient{
		claimTaskFn: func(ctx context.Context, runnerID int64) (*runnerclient.Task, error) {
			return nil, errors.New("claim failed")
		},
	})

	_, err := pool.ClaimTask(context.Background(), 8)
	require.Error(t, err)
}

func TestAPIPool_CompleteTask(t *testing.T) {
	t.Parallel()

	pool := NewAPIPool(&mockAPITaskClient{
		completeTaskFn: func(ctx context.Context, taskID, runnerID int64, status, errorMessage string) error {
			assert.Equal(t, int64(14), taskID)
			assert.Equal(t, int64(5), runnerID)
			assert.Equal(t, "failed", status)
			assert.Equal(t, "exit status 1", errorMessage)
			return nil
		},
	})

	require.NoError(t, pool.CompleteTask(context.Background(), 14, 5, "failed", "exit status 1"))
}
