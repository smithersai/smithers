package executor

import (
	"context"
	"errors"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type cancellableTaskPool struct {
	status       atomic.Value
	statusErr    error
	completed    atomic.Int32
	cleanupDone  atomic.Bool
	completionCh chan string
}

func (p *cancellableTaskPool) ClaimTask(context.Context, int64) (*db.WorkflowTask, error) {
	return nil, nil
}
func (p *cancellableTaskPool) GetTaskStatus(context.Context, int64, int64) (string, error) {
	if p.statusErr != nil {
		return "", p.statusErr
	}
	return p.status.Load().(string), nil
}
func (p *cancellableTaskPool) CompleteTask(_ context.Context, _, _ int64, status, _ string) error {
	if !p.cleanupDone.Load() {
		return errors.New("completion preceded isolation cleanup")
	}
	p.completed.Add(1)
	p.completionCh <- status
	return nil
}

func TestExecutor_CancelledRunningTaskStopsChildAndReleasesAfterCleanup(t *testing.T) {
	pool := &cancellableTaskPool{completionCh: make(chan string, 1)}
	pool.status.Store("running")
	started := make(chan struct{})
	e := NewExecutor(pool, 7, Config{
		TaskTimeout:            time.Minute,
		TaskStatusPollInterval: 10 * time.Millisecond,
		CommandFn: func(ctx context.Context, _ db.WorkflowTask) *exec.Cmd {
			return exec.CommandContext(ctx, "sleep", "30")
		},
		CleanupTask: func(context.Context, db.WorkflowTask) error {
			pool.cleanupDone.Store(true)
			return nil
		},
		OnTaskStart: func(db.WorkflowTask) { close(started) },
	})
	finished := make(chan error, 1)
	go func() { finished <- e.executeTask(context.Background(), db.WorkflowTask{ID: 11, WorkflowRunID: 12}) }()
	<-started
	pool.status.Store("cancelled")
	select {
	case err := <-finished:
		require.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled task kept its child and runner lease")
	}
	assert.Equal(t, "failed", <-pool.completionCh) // API acknowledges pre-existing cancelled status
	assert.True(t, pool.cleanupDone.Load())
}

func TestExecutor_RepeatedTaskStatusErrorsStopRunnerForRequeue(t *testing.T) {
	pool := &cancellableTaskPool{statusErr: errors.New("status API unavailable"), completionCh: make(chan string, 1)}
	e := NewExecutor(pool, 7, Config{
		TaskTimeout:            time.Minute,
		TaskStatusPollInterval: 10 * time.Millisecond,
		CommandFn: func(ctx context.Context, _ db.WorkflowTask) *exec.Cmd {
			return exec.CommandContext(ctx, "sleep", "30")
		},
		CleanupTask: func(context.Context, db.WorkflowTask) error {
			pool.cleanupDone.Store(true)
			return nil
		},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := e.executeTask(ctx, db.WorkflowTask{ID: 11, WorkflowRunID: 12})
	require.ErrorContains(t, err, "task status polling failed 3 times")
	assert.Zero(t, pool.completed.Load(), "unverified task stays running for TerminateRunner to requeue")
	assert.True(t, pool.cleanupDone.Load())
}
