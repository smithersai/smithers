// internal/runner/executor/executor_test.go - Tests for task executor
package executor

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// ---------------------------------------------------------------------------
// Thread-safe mock pool
// ---------------------------------------------------------------------------

type mockPool struct {
	mu sync.Mutex

	claimTaskFn    func(ctx context.Context, runnerID int64) (*db.WorkflowTask, error)
	completeTaskFn func(ctx context.Context, taskID int64, runnerID int64, status string) error

	claimCallCount       int
	completeCallCount    int
	lastCompleteID       int64
	lastCompleteRunnerID int64
	lastCompleteStatus   string
	lastCompleteError    string
}

func (m *mockPool) ClaimTask(ctx context.Context, runnerID int64) (*db.WorkflowTask, error) {
	m.mu.Lock()
	m.claimCallCount++
	m.mu.Unlock()
	if m.claimTaskFn != nil {
		return m.claimTaskFn(ctx, runnerID)
	}
	return nil, nil
}

func (m *mockPool) CompleteTask(ctx context.Context, taskID int64, runnerID int64, status, errorMessage string) error {
	m.mu.Lock()
	m.completeCallCount++
	m.lastCompleteID = taskID
	m.lastCompleteRunnerID = runnerID
	m.lastCompleteStatus = status
	m.lastCompleteError = errorMessage
	m.mu.Unlock()
	if m.completeTaskFn != nil {
		return m.completeTaskFn(ctx, taskID, runnerID, status)
	}
	return nil
}

func (m *mockPool) getClaimCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.claimCallCount
}

func (m *mockPool) getCompleteCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.completeCallCount
}

func (m *mockPool) getLastStatus() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastCompleteStatus
}

func (m *mockPool) getLastError() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastCompleteError
}

func (m *mockPool) getLastRunnerID() int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastCompleteRunnerID
}

func (m *mockPool) getLastTaskID() int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastCompleteID
}

var _ TaskPool = (*mockPool)(nil)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("waitFor: timed out waiting for condition")
}

func successCmd(ctx context.Context, _ db.WorkflowTask) *exec.Cmd {
	return exec.CommandContext(ctx, "true")
}

func failCmd(ctx context.Context, _ db.WorkflowTask) *exec.Cmd {
	return exec.CommandContext(ctx, "false")
}

func longSleepCmd(ctx context.Context, _ db.WorkflowTask) *exec.Cmd {
	return exec.CommandContext(ctx, "sleep", "60")
}

func executeStepSuccessCmd(ctx context.Context, _ db.WorkflowTask) *exec.Cmd {
	return exec.CommandContext(ctx, "sh", "-c", "exit 0", "cmd/runner/workflow/execute-step.ts")
}

func executeStepFailCmd(ctx context.Context, _ db.WorkflowTask) *exec.Cmd {
	return exec.CommandContext(ctx, "sh", "-c", "exit 1", "cmd/runner/workflow/execute-step.ts")
}

func executeStepStartFailureCmd(ctx context.Context, _ db.WorkflowTask) *exec.Cmd {
	return exec.CommandContext(ctx, "smithers-missing-execute-step-binary", "run", "cmd/runner/workflow/execute-step.ts")
}

func setupFailureCmd(ctx context.Context, _ db.WorkflowTask) *exec.Cmd {
	return exec.CommandContext(ctx, "sh", "-c", "exit 1")
}

func TestNewExecutor_CreatesExecutorWithConfig(t *testing.T) {
	t.Parallel()
	pool := &mockPool{}
	config := Config{
		PollInterval: 100 * time.Millisecond,
		TaskTimeout:  5 * time.Minute,
	}
	e := NewExecutor(pool, 42, config)
	require.NotNil(t, e)
	assert.Equal(t, int64(42), e.runnerID)
	assert.Equal(t, 100*time.Millisecond, e.config.PollInterval)
	assert.Equal(t, 5*time.Minute, e.config.TaskTimeout)
}

func TestConfig_DefaultValues(t *testing.T) {
	t.Parallel()
	config := Config{}
	assert.Equal(t, time.Duration(0), config.PollInterval)
	assert.Equal(t, time.Duration(0), config.TaskTimeout)
	assert.Equal(t, time.Duration(0), config.CompleteTaskTimeout)
	assert.Nil(t, config.CommandFn)
	assert.Nil(t, config.Stdout)
	assert.Nil(t, config.Stderr)
}

func TestExecutor_StartStop(t *testing.T) {
	t.Parallel()
	pool := &mockPool{
		claimTaskFn: func(ctx context.Context, runnerID int64) (*db.WorkflowTask, error) {
			return nil, nil
		},
	}
	config := Config{
		PollInterval: 10 * time.Millisecond,
		TaskTimeout:  1 * time.Second,
	}
	e := NewExecutor(pool, 1, config)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e.Start(ctx)
	waitFor(t, 500*time.Millisecond, func() bool { return pool.getClaimCount() >= 1 })
	e.Stop()
	assert.GreaterOrEqual(t, pool.getClaimCount(), 1)
}

func TestExecutor_Stop_CancelsContext(t *testing.T) {
	t.Parallel()
	pool := &mockPool{}
	config := Config{
		PollInterval: 10 * time.Millisecond,
		TaskTimeout:  1 * time.Second,
	}
	e := NewExecutor(pool, 1, config)
	e.Start(context.Background())
	e.Stop()
	select {
	case <-e.stopCh:
	default:
		t.Error("stopCh should be closed after Stop()")
	}
}

func TestExecutor_CompleteTaskUsesTimeoutContext(t *testing.T) {
	t.Parallel()

	const completeTimeout = 250 * time.Millisecond

	// The completion context is created after the child has exited and the
	// quarantine cleanup has returned, so the cleanup hook is the last
	// observable moment before the deadline is computed, and the pool call is
	// the first one after. Bounding the deadline by those two instants makes
	// the assertion exact regardless of how long the child or the scheduler
	// took: no wall-clock tolerance, no dependence on machine load.
	var cleanupReturned, completeCalled, deadline time.Time
	pool := &mockPool{
		completeTaskFn: func(ctx context.Context, taskID int64, runnerID int64, status string) error {
			completeCalled = time.Now()
			var ok bool
			deadline, ok = ctx.Deadline()
			require.True(t, ok, "CompleteTask must run under a deadline")
			assert.Equal(t, int64(42), taskID)
			assert.Equal(t, int64(7), runnerID)
			assert.Equal(t, "done", status)
			return nil
		},
	}
	e := NewExecutor(pool, 7, Config{
		TaskTimeout:         time.Second,
		CompleteTaskTimeout: completeTimeout,
		CommandFn:           successCmd,
		CleanupTask: func(context.Context, db.WorkflowTask) error {
			cleanupReturned = time.Now()
			return nil
		},
	})

	require.NoError(t, e.executeTask(context.Background(), db.WorkflowTask{ID: 42, WorkflowRunID: 3}))
	require.False(t, cleanupReturned.IsZero(), "cleanup hook must run before completion")
	require.False(t, completeCalled.IsZero(), "CompleteTask must be called")

	// deadline = T_ctx + completeTimeout with cleanupReturned <= T_ctx <= completeCalled.
	assert.False(t, deadline.Before(cleanupReturned.Add(completeTimeout)),
		"deadline %s is earlier than cleanup-return %s + %s: the completion timeout is shorter than configured",
		deadline, cleanupReturned, completeTimeout)
	assert.False(t, deadline.After(completeCalled.Add(completeTimeout)),
		"deadline %s is later than CompleteTask-call %s + %s: the completion timeout is longer than configured",
		deadline, completeCalled, completeTimeout)
}

func TestExecutor_StartedExecuteStepCommandSuccess_SendsTrustedAcknowledgement(t *testing.T) {
	t.Parallel()

	pool := &mockPool{}
	e := NewExecutor(pool, 9, Config{
		TaskTimeout:         time.Second,
		CompleteTaskTimeout: time.Second,
		CommandFn:           executeStepSuccessCmd,
	})

	e.executeTask(context.Background(), db.WorkflowTask{
		ID:            41,
		WorkflowRunID: 12,
		Payload:       []byte(`{"job":"build","steps":[]}`),
	})

	assert.Equal(t, 1, pool.getCompleteCount(),
		"the trusted runner must settle the task after execute-step.ts exits")
	assert.Equal(t, "done", pool.getLastStatus())
}

// The trusted parent converts a non-zero child exit into terminal failure. The
// untrusted execute-step.ts child never gets authority to settle its own task.
func TestExecutor_StartedExecuteStepCommandFailure_CallsCompleteTaskFailed(t *testing.T) {
	t.Parallel()

	pool := &mockPool{}
	e := NewExecutor(pool, 9, Config{
		TaskTimeout:         time.Second,
		CompleteTaskTimeout: time.Second,
		CommandFn:           executeStepFailCmd,
	})

	e.executeTask(context.Background(), db.WorkflowTask{
		ID:            41,
		WorkflowRunID: 12,
		Payload:       []byte(`{"job":"build","steps":[]}`),
	})

	assert.Equal(t, 1, pool.getCompleteCount(),
		"pool.CompleteTask must be called when the workflow child exits non-zero")
	assert.Equal(t, "failed", pool.getLastStatus())
	assert.Equal(t, "exit status 1", pool.getLastError(),
		"the trusted parent must persist a diagnostic for failed child commands")
}

func TestExecutor_WorkflowSetupFailureCompletesFailed(t *testing.T) {
	t.Parallel()

	pool := &mockPool{}
	e := NewExecutor(pool, 9, Config{
		TaskTimeout:         time.Second,
		CompleteTaskTimeout: time.Second,
		CommandFn:           setupFailureCmd,
	})

	e.executeTask(context.Background(), db.WorkflowTask{
		ID:            42,
		WorkflowRunID: 12,
		Payload:       []byte(`{"job":"build","steps":[]}`),
	})

	assert.Equal(t, 1, pool.getCompleteCount())
	assert.Equal(t, "failed", pool.getLastStatus())
	assert.NotEmpty(t, pool.getLastError())
}

func TestExecutor_ExecuteStepStartFailureCompletesFailed(t *testing.T) {
	t.Parallel()

	pool := &mockPool{}
	e := NewExecutor(pool, 9, Config{
		TaskTimeout:         time.Second,
		CompleteTaskTimeout: time.Second,
		CommandFn:           executeStepStartFailureCmd,
	})

	e.executeTask(context.Background(), db.WorkflowTask{
		ID:            43,
		WorkflowRunID: 12,
		Payload:       []byte(`{"job":"build","steps":[]}`),
	})

	assert.Equal(t, 1, pool.getCompleteCount())
	assert.Equal(t, "failed", pool.getLastStatus())
}

func TestExecutor_AgentTaskWithJobFieldsStillUsesPoolCompletion(t *testing.T) {
	t.Parallel()

	pool := &mockPool{}
	e := NewExecutor(pool, 9, Config{
		TaskTimeout:         time.Second,
		CompleteTaskTimeout: time.Second,
		CommandFn:           successCmd,
	})

	e.executeTask(context.Background(), db.WorkflowTask{
		ID:            42,
		WorkflowRunID: 12,
		Payload:       []byte(`{"kind":"agent","job":"build","steps":[]}`),
	})

	assert.Equal(t, 1, pool.getCompleteCount())
	assert.Equal(t, "done", pool.getLastStatus())
}

func TestExecutorWait_UnblocksAfterContextCancellation(t *testing.T) {
	t.Parallel()
	pool := &mockPool{
		claimTaskFn: func(ctx context.Context, runnerID int64) (*db.WorkflowTask, error) {
			return nil, nil
		},
	}
	config := Config{
		PollInterval: 10 * time.Millisecond,
		TaskTimeout:  1 * time.Second,
	}
	e := NewExecutor(pool, 1, config)
	ctx, cancel := context.WithCancel(context.Background())
	e.Start(ctx)
	waitFor(t, 500*time.Millisecond, func() bool { return pool.getClaimCount() >= 1 })
	cancel()
	done := make(chan struct{})
	go func() { e.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Wait() did not unblock after context cancellation")
	}
}

func TestExecutorLoop_PollsAtConfiguredInterval(t *testing.T) {
	t.Parallel()
	pool := &mockPool{
		claimTaskFn: func(ctx context.Context, runnerID int64) (*db.WorkflowTask, error) {
			return nil, nil
		},
	}
	config := Config{
		PollInterval: 100 * time.Millisecond,
		TaskTimeout:  1 * time.Second,
	}
	e := NewExecutor(pool, 1, config)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e.Start(ctx)
	time.Sleep(50 * time.Millisecond)
	countAfter50ms := pool.getClaimCount()
	waitFor(t, 300*time.Millisecond, func() bool { return pool.getClaimCount() > countAfter50ms })
	e.Stop()
	assert.Greater(t, pool.getClaimCount(), countAfter50ms)
}

func TestExecutorLoop_RespectsStopSignal(t *testing.T) {
	t.Parallel()
	pool := &mockPool{
		claimTaskFn: func(ctx context.Context, runnerID int64) (*db.WorkflowTask, error) {
			return nil, nil
		},
	}
	config := Config{
		PollInterval: 10 * time.Millisecond,
		TaskTimeout:  1 * time.Second,
	}
	e := NewExecutor(pool, 1, config)
	e.Start(context.Background())
	waitFor(t, 500*time.Millisecond, func() bool { return pool.getClaimCount() >= 1 })
	e.Stop()
	countAfterStop := pool.getClaimCount()
	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, countAfterStop, pool.getClaimCount())
}

func TestExecutorLoop_RespectsContextCancel(t *testing.T) {
	t.Parallel()
	pool := &mockPool{
		claimTaskFn: func(ctx context.Context, runnerID int64) (*db.WorkflowTask, error) {
			return nil, nil
		},
	}
	config := Config{
		PollInterval: 10 * time.Millisecond,
		TaskTimeout:  1 * time.Second,
	}
	e := NewExecutor(pool, 1, config)
	ctx, cancel := context.WithCancel(context.Background())
	e.Start(ctx)
	waitFor(t, 500*time.Millisecond, func() bool { return pool.getClaimCount() >= 1 })
	cancel()
	e.Wait()
	countAfterCancel := pool.getClaimCount()
	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, countAfterCancel, pool.getClaimCount())
}

func TestExecutor_ExecuteTask_AcknowledgesSelfCompletingWorkflowStepTask(t *testing.T) {
	t.Parallel()

	pool := &mockPool{}
	task := db.WorkflowTask{
		ID:      77,
		Status:  "assigned",
		Payload: []byte(`{"job":"build","steps":[{"run":"echo hi"}]}`),
	}
	e := NewExecutor(pool, 9, Config{
		PollInterval: 10 * time.Millisecond,
		TaskTimeout:  time.Second,
		CommandFn:    executeStepSuccessCmd,
	})

	e.executeTask(context.Background(), task)
	assert.Equal(t, 1, pool.getCompleteCount())
}

func TestExecutorPollAndExecute_NoTask(t *testing.T) {
	t.Parallel()
	pool := &mockPool{
		claimTaskFn: func(ctx context.Context, runnerID int64) (*db.WorkflowTask, error) {
			return nil, nil
		},
	}
	e := NewExecutor(pool, 1, Config{PollInterval: 10 * time.Millisecond, TaskTimeout: 1 * time.Second})
	e.pollAndExecute(context.Background())
	assert.Equal(t, 0, pool.getCompleteCount())
}

func TestExecutorPollAndExecute_ClaimError(t *testing.T) {
	t.Parallel()
	pool := &mockPool{
		claimTaskFn: func(ctx context.Context, runnerID int64) (*db.WorkflowTask, error) {
			return nil, errors.New("database error")
		},
	}
	e := NewExecutor(pool, 1, Config{PollInterval: 10 * time.Millisecond, TaskTimeout: 1 * time.Second})
	err := e.pollAndExecute(context.Background())
	assert.ErrorIs(t, err, errClaimTask)
	assert.Equal(t, 0, pool.getCompleteCount())
}

func TestExecutor_ClaimFailureBudgetResetsAfterSuccessfulPoll(t *testing.T) {
	var attempts atomic.Int32
	pool := &mockPool{claimTaskFn: func(context.Context, int64) (*db.WorkflowTask, error) {
		n := attempts.Add(1)
		if n == 3 {
			return nil, nil
		}
		return nil, errors.New("claim API unavailable")
	}}
	fatal := make(chan error, 1)
	e := NewExecutor(pool, 1, Config{
		PollInterval: time.Millisecond,
		OnFatalError: func(err error) { fatal <- err },
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	e.Start(ctx)
	select {
	case err := <-fatal:
		assert.ErrorIs(t, err, errClaimTask)
		assert.EqualValues(t, 6, attempts.Load(), "successful claim resets the failure budget")
	case <-ctx.Done():
		t.Fatal("runner kept polling after repeated claim failures")
	}
	e.Wait()
}

func TestExecutorPollAndExecute_ExecutesClaimedTask(t *testing.T) {
	t.Parallel()
	pool := &mockPool{
		claimTaskFn: func(ctx context.Context, runnerID int64) (*db.WorkflowTask, error) {
			return &db.WorkflowTask{ID: 123, Status: "assigned"}, nil
		},
	}
	e := NewExecutor(pool, 1, Config{PollInterval: 10 * time.Millisecond, TaskTimeout: 1 * time.Second, CommandFn: successCmd})
	e.pollAndExecute(context.Background())
	assert.Equal(t, 1, pool.getCompleteCount())
	assert.Equal(t, int64(123), pool.getLastTaskID())
	assert.Equal(t, "done", pool.getLastStatus())
}

func TestExecutorExecuteTask_MarksDoneOnSuccess(t *testing.T) {
	t.Parallel()
	pool := &mockPool{}
	e := NewExecutor(pool, 1, Config{TaskTimeout: 1 * time.Second, CommandFn: successCmd})
	e.executeTask(context.Background(), db.WorkflowTask{ID: 456})
	assert.Equal(t, 1, pool.getCompleteCount())
	assert.Equal(t, int64(456), pool.getLastTaskID())
	assert.Equal(t, "done", pool.getLastStatus())
}

func TestExecutorExecuteTask_MarksFailedOnCommandError(t *testing.T) {
	t.Parallel()
	pool := &mockPool{}
	e := NewExecutor(pool, 1, Config{TaskTimeout: 1 * time.Second, CommandFn: failCmd})
	e.executeTask(context.Background(), db.WorkflowTask{ID: 789})
	assert.Equal(t, 1, pool.getCompleteCount())
	assert.Equal(t, int64(789), pool.getLastTaskID())
	assert.Equal(t, "failed", pool.getLastStatus())
}

func TestExecutorExecuteTask_RetryLimitSettlesWithoutLaunchingUntrustedCommand(t *testing.T) {
	t.Parallel()

	pool := &mockPool{}
	commandCalled := false
	cleanupCalled := false
	e := NewExecutor(pool, 7, Config{
		TaskTimeout: time.Second,
		CommandFn: func(context.Context, db.WorkflowTask) *exec.Cmd {
			commandCalled = true
			return exec.Command("true")
		},
		CleanupTask: func(context.Context, db.WorkflowTask) error {
			cleanupCalled = true
			return nil
		},
	})

	require.NoError(t, e.executeTask(context.Background(), db.WorkflowTask{
		ID: 810, WorkflowRunID: 811, Attempt: maxTaskExecutionAttempts + 1,
	}))
	assert.False(t, commandCalled, "an exhausted task must not launch repository-controlled code again")
	assert.True(t, cleanupCalled, "the runner isolation boundary still runs before settlement")
	assert.Equal(t, 1, pool.getCompleteCount())
	assert.Equal(t, "failed", pool.getLastStatus())
}

func TestExecutorExecuteTask_LastAllowedAttemptStillExecutes(t *testing.T) {
	t.Parallel()

	pool := &mockPool{}
	commandCalled := false
	e := NewExecutor(pool, 7, Config{
		TaskTimeout: time.Second,
		CommandFn: func(ctx context.Context, _ db.WorkflowTask) *exec.Cmd {
			commandCalled = true
			return exec.CommandContext(ctx, "true")
		},
	})
	require.NoError(t, e.executeTask(context.Background(), db.WorkflowTask{
		ID: 812, WorkflowRunID: 813, Attempt: maxTaskExecutionAttempts,
	}))
	assert.True(t, commandCalled)
	assert.Equal(t, "done", pool.getLastStatus())
}

func TestExecutorExecuteTask_MarksFailedOnTimeout(t *testing.T) {
	t.Parallel()
	pool := &mockPool{}
	e := NewExecutor(pool, 1, Config{TaskTimeout: 50 * time.Millisecond, CommandFn: longSleepCmd})
	e.executeTask(context.Background(), db.WorkflowTask{ID: 999})
	assert.Equal(t, 1, pool.getCompleteCount())
	assert.Equal(t, int64(999), pool.getLastTaskID())
	assert.Equal(t, "failed", pool.getLastStatus())
}

// Issue #60: when the parent (runner shutdown) context is cancelled mid-task,
// the task must be left alone (not marked 'failed' via CompleteTask) so that
// TerminateRunner -> RequeueTasksForRunner can pick it up for a healthy runner.
func TestExecutorExecuteTask_SkipsCompleteOnParentContextCancel(t *testing.T) {
	t.Parallel()
	pool := &mockPool{}
	e := NewExecutor(pool, 1, Config{TaskTimeout: 5 * time.Second, CommandFn: longSleepCmd})
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	e.executeTask(ctx, db.WorkflowTask{ID: 888})
	assert.Equal(t, 0, pool.getCompleteCount(),
		"CompleteTask must not be called when the parent context was cancelled (shutdown/requeue path)")
}

// Same as above, but specifically for execute-step.ts: a mid-task parent
// cancellation must skip CompleteTask so the task is requeued rather than
// marked failed.
func TestExecutorExecuteTask_WorkflowChild_SkipsCompleteOnParentContextCancel(t *testing.T) {
	t.Parallel()
	pool := &mockPool{}
	e := NewExecutor(pool, 1, Config{
		TaskTimeout: 5 * time.Second,
		CommandFn: func(ctx context.Context, _ db.WorkflowTask) *exec.Cmd {
			return exec.CommandContext(ctx, "sh", "-c", "sleep 30", "cmd/runner/workflow/execute-step.ts")
		},
	})
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	e.executeTask(ctx, db.WorkflowTask{ID: 889})
	assert.Equal(t, 0, pool.getCompleteCount(),
		"CompleteTask must not be called when the parent context was cancelled (shutdown/requeue path)")
}

func TestExecutorExecuteTask_PassesRunnerID(t *testing.T) {
	t.Parallel()
	pool := &mockPool{}
	e := NewExecutor(pool, 42, Config{TaskTimeout: 1 * time.Second, CommandFn: successCmd})
	e.executeTask(context.Background(), db.WorkflowTask{ID: 123})
	assert.Equal(t, int64(42), pool.getLastRunnerID())
	assert.Equal(t, int64(123), pool.getLastTaskID())
	assert.Equal(t, "done", pool.getLastStatus())
}

func TestExecutorExecuteTask_LogsCompleteTaskError(t *testing.T) {
	t.Parallel()
	var logBuf bytes.Buffer
	pool := &mockPool{
		completeTaskFn: func(ctx context.Context, taskID int64, runnerID int64, status string) error {
			return errors.New("database connection lost")
		},
	}
	e := NewExecutor(pool, 1, Config{TaskTimeout: 1 * time.Second, CommandFn: successCmd, Stderr: &logBuf})
	e.executeTask(context.Background(), db.WorkflowTask{ID: 456})
	assert.Equal(t, 1, pool.getCompleteCount())
	assert.Contains(t, logBuf.String(), "failed to complete task")
	assert.Contains(t, logBuf.String(), "database connection lost")
}

func TestExecutorExecuteTask_WiresStdoutStderr(t *testing.T) {
	t.Parallel()
	var stdout, stderr bytes.Buffer
	pool := &mockPool{}
	e := NewExecutor(pool, 1, Config{
		TaskTimeout: 1 * time.Second,
		CommandFn: func(ctx context.Context, task db.WorkflowTask) *exec.Cmd {
			return exec.CommandContext(ctx, "echo", "hello-from-task")
		},
		Stdout: &stdout,
		Stderr: &stderr,
	})
	e.executeTask(context.Background(), db.WorkflowTask{ID: 1})
	assert.Contains(t, stdout.String(), "hello-from-task")
	assert.Equal(t, "done", pool.getLastStatus())
}

func TestExecutorStop_WaitsForInFlightTaskThenExits(t *testing.T) {
	t.Parallel()
	var taskStarted int32
	var claimed int32
	pool := &mockPool{
		claimTaskFn: func(ctx context.Context, runnerID int64) (*db.WorkflowTask, error) {
			// Only return a task on the first claim.
			if atomic.CompareAndSwapInt32(&claimed, 0, 1) {
				return &db.WorkflowTask{ID: 77}, nil
			}
			return nil, nil
		},
	}
	e := NewExecutor(pool, 1, Config{
		PollInterval: 10 * time.Millisecond,
		TaskTimeout:  5 * time.Second,
		CommandFn: func(ctx context.Context, task db.WorkflowTask) *exec.Cmd {
			atomic.StoreInt32(&taskStarted, 1)
			return exec.CommandContext(ctx, "sleep", "0.2")
		},
	})
	e.Start(context.Background())
	// Wait for the task to begin executing.
	waitFor(t, 2*time.Second, func() bool { return atomic.LoadInt32(&taskStarted) == 1 })
	// Stop should block until the in-flight task completes.
	stopped := make(chan struct{})
	go func() { e.Stop(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop() did not return after in-flight task finished")
	}
	assert.GreaterOrEqual(t, pool.getCompleteCount(), 1)
	assert.Equal(t, "done", pool.getLastStatus())
}

func TestExecutor_UsesRunnerPool(t *testing.T) {
	t.Parallel()
	type poolInterface interface {
		ClaimTask(ctx context.Context, runnerID int64) (*db.WorkflowTask, error)
		CompleteTask(ctx context.Context, taskID int64, runnerID int64, status, errorMessage string) error
	}
	var _ poolInterface = (*mockPool)(nil)
	pool := &mockPool{}
	e := NewExecutor(pool, 1, Config{})
	assert.NotNil(t, e)
}

func TestExecutor_WithRealPoolInterface(t *testing.T) {
	t.Parallel()
	var capturedRunnerID int64
	var mu sync.Mutex
	pool := &mockPool{
		claimTaskFn: func(ctx context.Context, runnerID int64) (*db.WorkflowTask, error) {
			mu.Lock()
			capturedRunnerID = runnerID
			mu.Unlock()
			return &db.WorkflowTask{ID: 100, Status: "running"}, nil
		},
	}
	e := NewExecutor(pool, 42, Config{PollInterval: 10 * time.Millisecond, TaskTimeout: 1 * time.Second, CommandFn: successCmd})
	e.pollAndExecute(context.Background())
	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, int64(42), capturedRunnerID)
	assert.Equal(t, int64(100), pool.getLastTaskID())
}

func TestExecutorExecuteTask_StatusDoneMatchesDBConstraint(t *testing.T) {
	t.Parallel()
	pool := &mockPool{}
	e := NewExecutor(pool, 1, Config{TaskTimeout: 1 * time.Second, CommandFn: successCmd})
	e.executeTask(context.Background(), db.WorkflowTask{ID: 1})
	status := pool.getLastStatus()
	assert.Equal(t, "done", status, "success status must be 'done' to match DB CHECK constraint")
	assert.NotEqual(t, "completed", status, "executor must NOT use 'completed'")
}

func TestExecutorExecuteTask_StatusFailedMatchesDBConstraint(t *testing.T) {
	t.Parallel()
	pool := &mockPool{}
	e := NewExecutor(pool, 1, Config{TaskTimeout: 1 * time.Second, CommandFn: failCmd})
	e.executeTask(context.Background(), db.WorkflowTask{ID: 1})
	status := pool.getLastStatus()
	assert.Equal(t, "failed", status, "failure status must be 'failed' to match DB CHECK constraint")
}

// Issue #60: if the parent ctx is already canceled before the command even
// runs, that is unambiguously a shutdown, so CompleteTask must not be called
// at all (the task is left 'running' for requeue). Independently, when
// CompleteTask IS invoked (see TestExecutor_CompleteTaskUsesTimeoutContext),
// it must use its own background-derived context.
func TestExecutorExecuteTask_SkipsCompleteWhenParentContextAlreadyCanceled(t *testing.T) {
	t.Parallel()
	var completeCalled bool
	pool := &mockPool{
		completeTaskFn: func(ctx context.Context, taskID int64, runnerID int64, status string) error {
			completeCalled = true
			return nil
		},
	}
	e := NewExecutor(pool, 1, Config{TaskTimeout: 50 * time.Millisecond, CommandFn: longSleepCmd})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	e.executeTask(ctx, db.WorkflowTask{ID: 555})
	assert.False(t, completeCalled, "CompleteTask must not be called when parent ctx is already canceled")
}
