package executor

import (
	"context"
	"os/exec"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestExecutor_Cov_OnPollHookRunsBeforeClaim(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var events []string
	pool := &mockPool{
		claimTaskFn: func(ctx context.Context, runnerID int64) (*db.WorkflowTask, error) {
			mu.Lock()
			defer mu.Unlock()
			events = append(events, "claim")
			return nil, nil
		},
	}
	e := NewExecutor(pool, 71, Config{
		PollInterval: 5 * time.Millisecond,
		TaskTimeout:  time.Second,
		OnPoll: func() {
			mu.Lock()
			defer mu.Unlock()
			events = append(events, "poll")
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e.Start(ctx)
	waitFor(t, time.Second, func() bool { return pool.getClaimCount() >= 1 })
	e.Stop()

	mu.Lock()
	defer mu.Unlock()
	require.GreaterOrEqual(t, len(events), 2)
	assert.Equal(t, []string{"poll", "claim"}, events[:2])
}

func TestExecutor_Cov_TaskLifecycleHooksObserveFailure(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var started []int64
	var finishedTaskID int64
	var finishedStatus string
	var finishedErr error

	pool := &mockPool{}
	e := NewExecutor(pool, 72, Config{
		TaskTimeout: time.Second,
		CommandFn: func(ctx context.Context, task db.WorkflowTask) *exec.Cmd {
			return exec.CommandContext(ctx, "sh", "-c", "exit 7")
		},
		OnTaskStart: func(task db.WorkflowTask) {
			mu.Lock()
			defer mu.Unlock()
			started = append(started, task.ID)
		},
		OnTaskFinish: func(task db.WorkflowTask, status string, err error) {
			mu.Lock()
			defer mu.Unlock()
			finishedTaskID = task.ID
			finishedStatus = status
			finishedErr = err
		},
	})

	e.executeTask(context.Background(), db.WorkflowTask{ID: 81, WorkflowRunID: 91})

	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, []int64{81}, started)
	assert.Equal(t, int64(81), finishedTaskID)
	assert.Equal(t, "failed", finishedStatus)
	require.Error(t, finishedErr)
	assert.Contains(t, finishedErr.Error(), "exit status 7")
	assert.Equal(t, 1, pool.getCompleteCount())
	assert.Equal(t, "failed", pool.getLastStatus())
}

func TestExecutor_Cov_InvalidPayloadDoesNotSelfComplete(t *testing.T) {
	t.Parallel()

	payload := []byte(`{"job":`)

	pool := &mockPool{}
	e := NewExecutor(pool, 73, Config{
		TaskTimeout:         time.Second,
		CompleteTaskTimeout: time.Second,
		CommandFn:           successCmd,
	})

	e.executeTask(context.Background(), db.WorkflowTask{
		ID:            82,
		WorkflowRunID: 92,
		Payload:       payload,
	})

	assert.Equal(t, 1, pool.getCompleteCount())
	assert.Equal(t, int64(82), pool.getLastTaskID())
	assert.Equal(t, "done", pool.getLastStatus())
}
