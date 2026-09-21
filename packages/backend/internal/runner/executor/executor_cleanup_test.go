package executor

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type cleanupOrderPool struct {
	mu     sync.Mutex
	tasks  []*db.WorkflowTask
	events []string
}

func (p *cleanupOrderPool) ClaimTask(context.Context, int64) (*db.WorkflowTask, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.tasks) == 0 {
		p.events = append(p.events, "claim-empty")
		return nil, nil
	}
	task := p.tasks[0]
	p.tasks = p.tasks[1:]
	p.events = append(p.events, fmt.Sprintf("claim-%d", task.ID))
	return task, nil
}

func (p *cleanupOrderPool) CompleteTask(_ context.Context, taskID, _ int64, _, _ string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.events = append(p.events, fmt.Sprintf("complete-%d", taskID))
	return nil
}

func (p *cleanupOrderPool) appendEvent(event string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.events = append(p.events, event)
}

func (p *cleanupOrderPool) snapshot() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.events...)
}

func TestExecutor_TaskIsolationCompletesAndCleansBeforeNextClaim(t *testing.T) {
	t.Parallel()

	pool := &cleanupOrderPool{tasks: []*db.WorkflowTask{{ID: 1}, {ID: 2}}}
	exec := NewExecutor(pool, 44, Config{
		TaskTimeout:         time.Second,
		CompleteTaskTimeout: time.Second,
		TaskCleanupTimeout:  time.Second,
		CommandFn:           successCmd,
		OnTaskFinish: func(task db.WorkflowTask, _ string, _ error) {
			pool.appendEvent(fmt.Sprintf("settled-%d", task.ID))
		},
		CleanupTask: func(_ context.Context, task db.WorkflowTask) error {
			pool.appendEvent(fmt.Sprintf("kill-%d", task.ID))
			pool.appendEvent(fmt.Sprintf("wipe-%d", task.ID))
			return nil
		},
	})

	require.NoError(t, exec.pollAndExecute(context.Background()))
	require.NoError(t, exec.pollAndExecute(context.Background()))
	assert.Equal(t, []string{
		"claim-1", "kill-1", "wipe-1", "complete-1", "settled-1",
		"claim-2", "kill-2", "wipe-2", "complete-2", "settled-2",
	}, pool.snapshot())
}

func TestExecutor_TaskIsolationFailureStopsPollingFailClosed(t *testing.T) {
	t.Parallel()

	cleanupErr := errors.New("workspace remained dirty")
	pool := &cleanupOrderPool{tasks: []*db.WorkflowTask{{ID: 1}, {ID: 2}}}
	fatal := make(chan error, 1)
	exec := NewExecutor(pool, 45, Config{
		PollInterval:        time.Millisecond,
		TaskTimeout:         time.Second,
		TaskCleanupTimeout:  time.Second,
		CompleteTaskTimeout: time.Second,
		CommandFn:           successCmd,
		CleanupTask: func(context.Context, db.WorkflowTask) error {
			return cleanupErr
		},
		OnFatalError: func(err error) {
			fatal <- err
		},
	})

	exec.Start(context.Background())
	select {
	case err := <-fatal:
		require.Error(t, err)
		assert.ErrorContains(t, err, cleanupErr.Error())
	case <-time.After(2 * time.Second):
		t.Fatal("executor did not report task isolation failure")
	}
	exec.Wait()

	assert.Equal(t, []string{"claim-1"}, pool.snapshot(),
		"cleanup failure must neither release the runner nor claim a second task")
}

func TestExecutor_ShutdownDuringCleanupDoesNotRequeueCompletedCommand(t *testing.T) {
	t.Parallel()

	pool := &mockPool{}
	cleanupStarted := make(chan struct{})
	releaseCleanup := make(chan struct{})
	exec := NewExecutor(pool, 46, Config{
		TaskTimeout:         time.Second,
		TaskCleanupTimeout:  time.Second,
		CompleteTaskTimeout: time.Second,
		CommandFn:           failCmd,
		CleanupTask: func(context.Context, db.WorkflowTask) error {
			close(cleanupStarted)
			<-releaseCleanup
			return nil
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- exec.executeTask(ctx, db.WorkflowTask{ID: 3, WorkflowRunID: 4})
	}()
	<-cleanupStarted
	cancel()
	close(releaseCleanup)
	require.NoError(t, <-done)

	assert.Equal(t, 1, pool.getCompleteCount(), "a command that exited before shutdown must be settled exactly once")
	assert.Equal(t, "failed", pool.getLastStatus())
}

// Quarantine only renames a finished task's state out of reach; the recursive
// unlink runs in the background. The runner must still refuse to claim another
// tenant's task until that removal has landed.
func TestExecutor_AwaitsIsolationDrainBeforeClaimingNextTask(t *testing.T) {
	t.Parallel()

	pool := &cleanupOrderPool{tasks: []*db.WorkflowTask{{ID: 1}, {ID: 2}}}
	exec := NewExecutor(pool, 47, Config{
		TaskTimeout:         time.Second,
		CompleteTaskTimeout: time.Second,
		TaskCleanupTimeout:  time.Second,
		CommandFn:           successCmd,
		CleanupTask: func(_ context.Context, task db.WorkflowTask) error {
			pool.appendEvent(fmt.Sprintf("quarantine-%d", task.ID))
			return nil
		},
		AwaitIsolation: func(context.Context) error {
			pool.appendEvent("drained")
			return nil
		},
	})

	require.NoError(t, exec.pollAndExecute(context.Background()))
	require.NoError(t, exec.pollAndExecute(context.Background()))
	assert.Equal(t, []string{
		"drained", "claim-1", "quarantine-1", "complete-1",
		"drained", "claim-2", "quarantine-2", "complete-2",
	}, pool.snapshot())
}

func TestExecutor_IsolationDrainFailureStopsPollingFailClosed(t *testing.T) {
	t.Parallel()

	drainErr := errors.New("quarantined tree survived")
	pool := &cleanupOrderPool{tasks: []*db.WorkflowTask{{ID: 1}}}
	exec := NewExecutor(pool, 48, Config{
		TaskTimeout:         time.Second,
		CompleteTaskTimeout: time.Second,
		TaskCleanupTimeout:  time.Second,
		CommandFn:           successCmd,
		AwaitIsolation:      func(context.Context) error { return drainErr },
	})

	err := exec.pollAndExecute(context.Background())
	require.Error(t, err)
	assert.ErrorIs(t, err, drainErr)
	assert.Empty(t, pool.snapshot(), "no task may be claimed while quarantined state is still on disk")
}

// The drain is joined with the runner's own context, so a shutdown must unwind
// the loop quietly instead of being reported as an isolation failure.
func TestExecutor_IsolationDrainCancelledByShutdownIsNotFatal(t *testing.T) {
	t.Parallel()

	pool := &cleanupOrderPool{tasks: []*db.WorkflowTask{{ID: 1}}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	exec := NewExecutor(pool, 49, Config{
		TaskTimeout:         time.Second,
		CompleteTaskTimeout: time.Second,
		TaskCleanupTimeout:  time.Second,
		CommandFn:           successCmd,
		AwaitIsolation:      func(ctx context.Context) error { return ctx.Err() },
	})

	require.NoError(t, exec.pollAndExecute(ctx))
	assert.Empty(t, pool.snapshot())
}
