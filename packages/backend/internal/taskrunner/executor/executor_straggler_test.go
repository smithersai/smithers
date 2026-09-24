package executor

import (
	"context"
	"os/exec"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A workflow child only reports its result through its exit status; the trusted
// executor settles it exactly once after exit and quarantine.
func TestExecutor_Straggler_WorkflowChildIsSettledByParent(t *testing.T) {
	t.Parallel()

	pool := &mockPool{}
	e := NewExecutor(pool, 74, Config{
		TaskTimeout:         time.Second,
		CompleteTaskTimeout: time.Second,
		CommandFn: func(ctx context.Context, _ db.WorkflowTask) *exec.Cmd {
			return exec.CommandContext(ctx, "true", "cmd/runner/workflow/execute-step.ts")
		},
	})

	e.executeTask(context.Background(), db.WorkflowTask{ID: 84, WorkflowRunID: 94})

	if got := pool.getCompleteCount(); got != 1 {
		t.Fatalf("workflow child should be settled once by its parent, got %d calls", got)
	}
}

// TestExecutor_Straggler_NilCommandFn covers the branch where the executor is
// configured without a CommandFn: it records the "command function is nil"
// error and still completes the task (with failure).
func TestExecutor_Straggler_NilCommandFn(t *testing.T) {
	t.Parallel()
	pool := &mockPool{}
	e := NewExecutor(pool, 75, Config{TaskTimeout: time.Second, CompleteTaskTimeout: time.Second})
	e.executeTask(context.Background(), db.WorkflowTask{ID: 85, WorkflowRunID: 95})
	if got := pool.getCompleteCount(); got != 1 {
		t.Fatalf("nil CommandFn should still complete the task once, got %d", got)
	}
}

// TestExecutor_Straggler_NilCommandReturned covers the branch where CommandFn
// returns a nil *exec.Cmd.
func TestExecutor_Straggler_NilCommandReturned(t *testing.T) {
	t.Parallel()
	pool := &mockPool{}
	e := NewExecutor(pool, 76, Config{
		TaskTimeout:         time.Second,
		CompleteTaskTimeout: time.Second,
		CommandFn:           func(context.Context, db.WorkflowTask) *exec.Cmd { return nil },
	})
	e.executeTask(context.Background(), db.WorkflowTask{ID: 86, WorkflowRunID: 96})
	if got := pool.getCompleteCount(); got != 1 {
		t.Fatalf("nil returned command should still complete the task once, got %d", got)
	}
}
