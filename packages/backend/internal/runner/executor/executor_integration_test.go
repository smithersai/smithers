package executor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type fakeCall struct {
	Method   string
	TaskID   int64
	RunnerID int64
	Status   string
}

type fakeTaskPool struct {
	mu    sync.Mutex
	calls []fakeCall
	tasks []*db.WorkflowTask
}

func (f *fakeTaskPool) ClaimTask(ctx context.Context, runnerID int64) (*db.WorkflowTask, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, fakeCall{Method: "ClaimTask", RunnerID: runnerID})
	if len(f.tasks) == 0 {
		return nil, nil
	}
	task := f.tasks[0]
	f.tasks = f.tasks[1:]
	return task, nil
}

func (f *fakeTaskPool) CompleteTask(ctx context.Context, taskID int64, runnerID int64, status, errorMessage string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, fakeCall{Method: "CompleteTask", TaskID: taskID, RunnerID: runnerID, Status: status})
	return nil
}

func (f *fakeTaskPool) getCalls() []fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]fakeCall, len(f.calls))
	copy(out, f.calls)
	return out
}

func (f *fakeTaskPool) getCompleteCalls() []fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []fakeCall
	for _, c := range f.calls {
		if c.Method == "CompleteTask" {
			out = append(out, c)
		}
	}
	return out
}

var _ TaskPool = (*fakeTaskPool)(nil)

func TestIntegration_TransitionsClaimedToDone(t *testing.T) {
	t.Parallel()
	pool := &fakeTaskPool{tasks: []*db.WorkflowTask{{ID: 10, Status: "assigned"}}}
	e := NewExecutor(pool, 7, Config{PollInterval: 10 * time.Millisecond, TaskTimeout: 1 * time.Second, CommandFn: successCmd})
	e.pollAndExecute(context.Background())
	completeCalls := pool.getCompleteCalls()
	require.Len(t, completeCalls, 1)
	assert.Equal(t, int64(10), completeCalls[0].TaskID)
	assert.Equal(t, int64(7), completeCalls[0].RunnerID)
	assert.Equal(t, "done", completeCalls[0].Status)
}

func TestIntegration_TransitionsClaimedToFailed(t *testing.T) {
	t.Parallel()
	pool := &fakeTaskPool{tasks: []*db.WorkflowTask{{ID: 20, Status: "assigned"}}}
	e := NewExecutor(pool, 8, Config{PollInterval: 10 * time.Millisecond, TaskTimeout: 1 * time.Second, CommandFn: failCmd})
	e.pollAndExecute(context.Background())
	completeCalls := pool.getCompleteCalls()
	require.Len(t, completeCalls, 1)
	assert.Equal(t, int64(20), completeCalls[0].TaskID)
	assert.Equal(t, int64(8), completeCalls[0].RunnerID)
	assert.Equal(t, "failed", completeCalls[0].Status)
}

func TestIntegration_ShutdownWithClaimedInFlightTask(t *testing.T) {
	t.Parallel()
	taskStarted := make(chan struct{})
	pool := &fakeTaskPool{tasks: []*db.WorkflowTask{{ID: 30, Status: "assigned"}}}
	e := NewExecutor(pool, 9, Config{
		PollInterval: 10 * time.Millisecond,
		TaskTimeout:  5 * time.Second,
		CommandFn: func(ctx context.Context, task db.WorkflowTask) *exec.Cmd {
			close(taskStarted)
			return exec.CommandContext(ctx, "sleep", "0.15")
		},
	})
	e.Start(context.Background())
	select {
	case <-taskStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("task never started")
	}
	stopped := make(chan struct{})
	go func() { e.Stop(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop() did not return after in-flight task finished")
	}
	completeCalls := pool.getCompleteCalls()
	require.GreaterOrEqual(t, len(completeCalls), 1)
	assert.Equal(t, "done", completeCalls[0].Status)
}

func TestIntegration_ExecutesMultipleTasksSequentially(t *testing.T) {
	t.Parallel()
	pool := &fakeTaskPool{tasks: []*db.WorkflowTask{
		{ID: 40, Status: "assigned"},
		{ID: 41, Status: "assigned"},
		{ID: 42, Status: "assigned"},
	}}
	e := NewExecutor(pool, 5, Config{PollInterval: 10 * time.Millisecond, TaskTimeout: 1 * time.Second, CommandFn: successCmd})
	e.pollAndExecute(context.Background())
	e.pollAndExecute(context.Background())
	e.pollAndExecute(context.Background())
	completeCalls := pool.getCompleteCalls()
	require.Len(t, completeCalls, 3)
	assert.Equal(t, int64(40), completeCalls[0].TaskID)
	assert.Equal(t, int64(41), completeCalls[1].TaskID)
	assert.Equal(t, int64(42), completeCalls[2].TaskID)
	for _, c := range completeCalls {
		assert.Equal(t, "done", c.Status)
		assert.Equal(t, int64(5), c.RunnerID)
	}
}

func TestIntegration_NoTasksAvailable(t *testing.T) {
	t.Parallel()
	pool := &fakeTaskPool{}
	e := NewExecutor(pool, 1, Config{PollInterval: 10 * time.Millisecond, TaskTimeout: 1 * time.Second, CommandFn: successCmd})
	e.pollAndExecute(context.Background())
	assert.Len(t, pool.getCompleteCalls(), 0, "no tasks should be completed when none are available")
}

func TestIntegration_FullLoopClaimExecuteComplete(t *testing.T) {
	t.Parallel()
	pool := &fakeTaskPool{tasks: []*db.WorkflowTask{{ID: 50, Status: "assigned"}}}
	e := NewExecutor(pool, 99, Config{PollInterval: 10 * time.Millisecond, TaskTimeout: 1 * time.Second, CommandFn: successCmd})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e.Start(ctx)
	waitFor(t, 2*time.Second, func() bool { return len(pool.getCompleteCalls()) >= 1 })
	e.Stop()
	calls := pool.getCalls()
	require.GreaterOrEqual(t, len(calls), 2)
	assert.Equal(t, "ClaimTask", calls[0].Method)
	assert.Equal(t, int64(99), calls[0].RunnerID)
	completeCalls := pool.getCompleteCalls()
	require.GreaterOrEqual(t, len(completeCalls), 1)
	assert.Equal(t, int64(50), completeCalls[0].TaskID)
	assert.Equal(t, int64(99), completeCalls[0].RunnerID)
	assert.Equal(t, "done", completeCalls[0].Status)
}

// ---------------------------------------------------------------------------
// Lifecycle-safety integration tests (TICKET-10)
// ---------------------------------------------------------------------------

// fakeLifecyclePool tracks runner state transitions to verify the
// run → complete → runner-idle lifecycle contract.
type fakeLifecyclePool struct {
	mu sync.Mutex

	tasks         []*db.WorkflowTask
	claimCalls    int
	completeCalls []fakeCall
	runnerIdle    bool // set to true when CompleteTask is called (simulating ReleaseRunner)
}

func (f *fakeLifecyclePool) ClaimTask(ctx context.Context, runnerID int64) (*db.WorkflowTask, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.claimCalls++
	if len(f.tasks) == 0 {
		return nil, nil
	}
	task := f.tasks[0]
	f.tasks = f.tasks[1:]
	return task, nil
}

func (f *fakeLifecyclePool) CompleteTask(ctx context.Context, taskID int64, runnerID int64, status, errorMessage string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.completeCalls = append(f.completeCalls, fakeCall{
		Method:   "CompleteTask",
		TaskID:   taskID,
		RunnerID: runnerID,
		Status:   status,
	})
	// Simulate ReleaseRunner: mark the runner idle after task completion.
	f.runnerIdle = true
	return nil
}

func (f *fakeLifecyclePool) getCompleteCalls() []fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]fakeCall, len(f.completeCalls))
	copy(out, f.completeCalls)
	return out
}

func (f *fakeLifecyclePool) isRunnerIdle() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.runnerIdle
}

var _ TaskPool = (*fakeLifecyclePool)(nil)

// TestIntegration_RunCompleteRunnerIdle verifies the full lifecycle:
// dispatch workflow → runner picks up task → executes → completes → runner back to idle.
func TestIntegration_RunCompleteRunnerIdle(t *testing.T) {
	t.Parallel()

	pool := &fakeLifecyclePool{
		tasks: []*db.WorkflowTask{{ID: 60, Status: "assigned", WorkflowRunID: 1001}},
	}

	const runnerID = int64(42)
	e := NewExecutor(pool, runnerID, Config{
		PollInterval:        10 * time.Millisecond,
		TaskTimeout:         5 * time.Second,
		CompleteTaskTimeout: 5 * time.Second,
		CommandFn:           successCmd,
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e.Start(ctx)

	// Wait for task to complete and runner to return to idle.
	waitFor(t, 3*time.Second, func() bool { return pool.isRunnerIdle() })
	e.Stop()

	completeCalls := pool.getCompleteCalls()
	require.Len(t, completeCalls, 1, "exactly one CompleteTask call expected")
	assert.Equal(t, int64(60), completeCalls[0].TaskID)
	assert.Equal(t, runnerID, completeCalls[0].RunnerID)
	assert.Equal(t, "done", completeCalls[0].Status)
	assert.True(t, pool.isRunnerIdle(), "runner must be idle after task completion")
}

// TestIntegration_CancelKillsSubprocess verifies that canceling the executor
// context (simulating a run cancellation) terminates the active subprocess, not
// just updates DB state. The subprocess PID is captured via the command function;
// we then verify the process is no longer running after cancellation.
func TestIntegration_CancelKillsSubprocess(t *testing.T) {
	t.Parallel()

	pidFile := filepath.Join(t.TempDir(), "subprocess.pid")

	pool := &fakeLifecyclePool{
		tasks: []*db.WorkflowTask{{ID: 70, Status: "assigned", WorkflowRunID: 1002}},
	}

	const runnerID = int64(43)
	e := NewExecutor(pool, runnerID, Config{
		PollInterval:        10 * time.Millisecond,
		TaskTimeout:         30 * time.Second,
		CompleteTaskTimeout: 5 * time.Second,
		CommandFn: func(ctx context.Context, task db.WorkflowTask) *exec.Cmd {
			// The subprocess writes its own PID to a file and then execs sleep
			// (keeping the same PID). Reading the PID from the file avoids racing
			// the executor's cmd.Start() write of the cmd.Process field.
			return exec.CommandContext(ctx, "sh", "-c",
				fmt.Sprintf("echo $$ > %q; exec sleep 60", pidFile))
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	e.Start(ctx)

	// Wait for the subprocess to start by polling the pidfile it writes.
	var pid int
	startDeadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(startDeadline) {
		if data, err := os.ReadFile(pidFile); err == nil {
			if p, convErr := strconv.Atoi(strings.TrimSpace(string(data))); convErr == nil && p > 0 {
				pid = p
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	require.Greater(t, pid, 0, "subprocess did not start within timeout")

	// Verify the process is running before cancellation.
	proc, err := os.FindProcess(pid)
	require.NoError(t, err)
	// On Unix, FindProcess always succeeds; send signal 0 to check liveness.
	require.NoError(t, proc.Signal(os.Signal(syscallSignal0())),
		"process should be alive before cancellation")

	// Cancel the executor context — this simulates a run cancellation.
	cancel()
	e.Wait()

	// After cancellation, the subprocess should be dead.
	// Allow a brief moment for OS to clean up.
	deadline := time.Now().Add(2 * time.Second)
	var processGone bool
	for time.Now().Before(deadline) {
		if err := proc.Signal(os.Signal(syscallSignal0())); err != nil {
			// ESRCH means the process no longer exists — killed successfully.
			processGone = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	assert.True(t, processGone, "subprocess (pid=%d) should be killed after context cancellation", pid)
}

// syscallSignal0 returns syscall.Signal(0) as os.Signal without importing syscall directly.
// Signal 0 does not kill the process but checks whether it is alive.
func syscallSignal0() syscall.Signal {
	return syscall.Signal(0)
}

// The trusted executor maps each workflow child's exit status and settles the
// task once, after process exit and quarantine.
func TestIntegration_WorkflowTaskIsSettledByTrustedParent(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name    string
		cmdFn   func(context.Context, db.WorkflowTask) *exec.Cmd
		wantCnt int
	}{
		{"success", executeStepSuccessCmd, 1},
		{"failure", executeStepFailCmd, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			pool := &fakeTaskPool{tasks: []*db.WorkflowTask{{
				ID:      80,
				Status:  "assigned",
				Payload: []byte(`{"job":"build","steps":[{"run":"echo hi"}]}`),
			}}}
			e := NewExecutor(pool, 1, Config{
				PollInterval:        10 * time.Millisecond,
				TaskTimeout:         time.Second,
				CompleteTaskTimeout: time.Second,
				CommandFn:           tc.cmdFn,
			})
			e.pollAndExecute(context.Background())
			completeCalls := pool.getCompleteCalls()
			assert.Len(t, completeCalls, tc.wantCnt,
				"pool.CompleteTask call count mismatch for workflow child (%s)", tc.name)
			wantStatus := "done"
			if tc.name == "failure" {
				wantStatus = "failed"
			}
			assert.Equal(t, wantStatus, completeCalls[0].Status)
		})
	}
}
