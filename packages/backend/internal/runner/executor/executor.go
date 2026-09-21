// internal/runner/executor/executor.go - Task executor for runner
package executor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"os/exec"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

const maxTaskExecutionAttempts int32 = 3

// defaultTaskCleanupTimeout is the fallback ceiling on post-task isolation.
// It is a safety net, not the expected duration: quarantine renames state
// aside in milliseconds and unlinks it in the background. The old 30s ceiling
// failed tasks and killed the runner whenever a checkout held a large
// node_modules tree.
const defaultTaskCleanupTimeout = 10 * time.Minute

// TaskPool defines the interface for task operations needed by the executor.
// CompleteTask receives runnerID so the pool can enforce DB ownership constraints.
type TaskPool interface {
	ClaimTask(ctx context.Context, runnerID int64) (*db.WorkflowTask, error)
	CompleteTask(ctx context.Context, taskID int64, runnerID int64, status, errorMessage string) error
}

// Config configures the executor behavior
type Config struct {
	PollInterval        time.Duration
	TaskTimeout         time.Duration
	CompleteTaskTimeout time.Duration
	TaskCleanupTimeout  time.Duration
	CommandFn           func(ctx context.Context, task db.WorkflowTask) *exec.Cmd
	// CleanupTask establishes the isolation boundary between sequential tasks.
	// It is invoked after the command exits but before the trusted runner settles
	// the task and releases its busy lease. The executor will not poll again
	// until cleanup succeeds, and exits fail-closed if cleanup returns an error.
	CleanupTask func(ctx context.Context, task db.WorkflowTask) error
	// AwaitIsolation blocks until the isolation boundary CleanupTask started is
	// complete on disk. CleanupTask only has to make the finished task's state
	// unreachable, which is cheap; actually unlinking a large tree happens in
	// the background and is joined here, before this runner claims work that
	// may belong to a different tenant. A failure is fatal, like CleanupTask.
	AwaitIsolation func(ctx context.Context) error
	Stdout         io.Writer
	Stderr         io.Writer
	OnPoll         func()
	OnTaskStart    func(task db.WorkflowTask)
	OnTaskFinish   func(task db.WorkflowTask, status string, err error)
	OnFatalError   func(err error)
}

// Executor executes tasks polled from the runner pool
type Executor struct {
	pool     TaskPool
	runnerID int64
	config   Config
	stopCh   chan struct{}
	doneCh   chan struct{}
}

// NewExecutor creates a new task executor
func NewExecutor(pool TaskPool, runnerID int64, config Config) *Executor {
	return &Executor{
		pool:     pool,
		runnerID: runnerID,
		config:   config,
		stopCh:   make(chan struct{}),
		doneCh:   make(chan struct{}),
	}
}

// Start begins the task execution loop
func (e *Executor) Start(ctx context.Context) {
	go e.loop(ctx)
}

// Stop stops the executor and waits for the loop to exit
func (e *Executor) Stop() {
	close(e.stopCh)
	<-e.doneCh
}

// Wait blocks until the executor loop has exited (for use after context cancel)
func (e *Executor) Wait() {
	<-e.doneCh
}

// loop polls for tasks and executes them
func (e *Executor) loop(ctx context.Context) {
	defer close(e.doneCh)

	ticker := time.NewTicker(e.config.PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-e.stopCh:
			return
		case <-ticker.C:
			if e.config.OnPoll != nil {
				e.config.OnPoll()
			}
			if err := e.pollAndExecute(ctx); err != nil {
				if e.config.OnFatalError != nil {
					e.config.OnFatalError(err)
				}
				return
			}
		}
	}
}

// pollAndExecute claims and executes a single task
func (e *Executor) pollAndExecute(ctx context.Context) error {
	if e.config.AwaitIsolation != nil {
		if err := e.config.AwaitIsolation(ctx); err != nil {
			if ctx.Err() != nil {
				// The runner is already shutting down; the loop exits next tick.
				return nil
			}
			return fmt.Errorf("runner task isolation drain failed: %w", err)
		}
	}

	task, err := e.pool.ClaimTask(ctx, e.runnerID)
	if err != nil {
		return nil
	}
	if task == nil {
		return nil
	}

	return e.executeTask(ctx, *task)
}

// executeTask runs the task command, quarantines all task-owned state, and only
// then asks the trusted runner control plane to settle the task and release the
// runner lease. Workflow children cannot report terminal state themselves, so
// dependencies never advance until both process exit and quarantine succeed.
func (e *Executor) executeTask(ctx context.Context, task db.WorkflowTask) error {
	taskCtx, cancel := context.WithTimeout(ctx, e.config.TaskTimeout)
	defer cancel()

	slog.Info("executing task",
		"task_id", task.ID,
		"workflow_run_id", task.WorkflowRunID,
		"runner_id", e.runnerID,
	)
	if e.config.OnTaskStart != nil {
		e.config.OnTaskStart(task)
	}

	var err error
	var cmd *exec.Cmd
	if task.Attempt > maxTaskExecutionAttempts {
		err = fmt.Errorf("task retry limit exceeded after %d execution attempts", maxTaskExecutionAttempts)
	} else if e.config.CommandFn == nil {
		err = errors.New("command function is nil")
	} else {
		cmd = e.config.CommandFn(taskCtx, task)
	}
	if err == nil {
		if cmd == nil {
			err = errors.New("command function returned nil")
		} else {
			cmd.Stdout = e.config.Stdout
			cmd.Stderr = e.config.Stderr
			err = cmd.Start()
			if err == nil {
				err = cmd.Wait()
			}
		}
	}

	status := "done"
	if err != nil {
		status = "failed"
	}
	// Classify interruption at the command boundary. Cleanup intentionally uses
	// a background context and may outlive the runner parent; a shutdown that
	// begins only after the child has already exited must not retroactively turn
	// a real command failure into an interruption/requeue.
	interruptedByShutdown := err != nil && ctx.Err() != nil
	finishErr := err
	// OnTaskFinish means the task is fully settled: the child has exited,
	// process/filesystem quarantine has completed, and the trusted completion
	// acknowledgement below has returned.
	defer func() {
		if e.config.OnTaskFinish != nil {
			e.config.OnTaskFinish(task, status, finishErr)
		}
	}()

	// Cleanup must still run when the parent context was cancelled. In that
	// case the task is left for TerminateRunner to requeue, but escaped
	// processes and mutable state must still be removed before this runner can
	// be restarted in the same pod.
	if e.config.CleanupTask != nil {
		cleanupTimeout := e.config.TaskCleanupTimeout
		if cleanupTimeout <= 0 {
			cleanupTimeout = defaultTaskCleanupTimeout
		}
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), cleanupTimeout)
		cleanupErr := e.config.CleanupTask(cleanupCtx, task)
		cleanupCancel()
		if cleanupErr != nil {
			finishErr = fmt.Errorf("runner task isolation cleanup failed: %w", cleanupErr)
			return finishErr
		}
	}

	// Issue #60: if the parent context was cancelled (runner internal shutdown /
	// ctx.Done in cmd/runner/main.go calls execCancel()), do NOT mark the task
	// terminally failed. Leave it status='running' so the subsequent
	// TerminateRunner -> RequeueTasksForRunner (matches status IN
	// ('assigned','running')) requeues it onto a healthy runner.
	if interruptedByShutdown {
		slog.Info("task interrupted by runner shutdown; leaving for requeue",
			"task_id", task.ID, "workflow_run_id", task.WorkflowRunID, "runner_id", e.runnerID)
		return nil
	}

	completeTimeout := e.config.CompleteTaskTimeout
	if completeTimeout <= 0 {
		completeTimeout = 15 * time.Second
	}
	completeCtx, completeCancel := context.WithTimeout(context.Background(), completeTimeout)
	defer completeCancel()

	errorMessage := ""
	if err != nil {
		// Workflow children cannot settle themselves, so retain the trusted
		// parent's command-boundary failure diagnostic. exec's public error
		// string excludes the child environment; cap it before crossing the API.
		errorMessage = truncateTaskDiagnostic(err.Error(), 4096)
	}
	if completeErr := e.pool.CompleteTask(completeCtx, task.ID, e.runnerID, status, errorMessage); completeErr != nil {
		e.logCompleteTaskError(task.ID, task.WorkflowRunID, status, completeErr)
		if finishErr == nil {
			finishErr = completeErr
		}
		// A failed settlement can leave the runner busy forever. Stop polling so
		// the outer lifecycle takes the runner offline and requeues a task that
		// was not already terminalized by the control plane.
		return fmt.Errorf("settle runner task: %w", completeErr)
	}

	return nil
}

func truncateTaskDiagnostic(message string, maxBytes int) string {
	if maxBytes <= 0 || len(message) <= maxBytes {
		return message
	}
	return message[:maxBytes]
}

func (e *Executor) logCompleteTaskError(taskID, workflowRunID int64, status string, err error) {
	slog.Error("failed to complete task",
		"task_id", taskID,
		"workflow_run_id", workflowRunID,
		"runner_id", e.runnerID,
		"status", status,
		"error", err,
	)
	// Also log to Stderr for backward compatibility with test harnesses.
	if e.config.Stderr != nil {
		logger := log.New(e.config.Stderr, "", 0)
		logger.Printf("failed to complete task task_id=%d runner_id=%d status=%s: %v", taskID, e.runnerID, status, err)
	}
}
