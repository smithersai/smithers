package services

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// getWorkflowTaskStatus retrieves the status of a workflow task by ID using raw SQL.
// This helper avoids dependency on generated sqlc methods that may not exist.
func getWorkflowTaskStatus(ctx context.Context, pool *pgxpool.Pool, taskID int64) (string, error) {
	var status string
	err := pool.QueryRow(ctx, `SELECT status FROM workflow_tasks WHERE id = $1`, taskID).Scan(&status)
	return status, err
}

// assignTaskToRunner simulates ClaimPendingTask by assigning the task and marking the runner busy.
func assignTaskToRunner(t *testing.T, pool *pgxpool.Pool, taskID int64, runnerID int64) {
	t.Helper()
	ctx := context.Background()
	tag, err := pool.Exec(ctx,
		`UPDATE runner_pool SET status = 'busy', updated_at = NOW() WHERE id = $1`,
		runnerID)
	require.NoError(t, err)
	require.Equal(t, int64(1), tag.RowsAffected(), "expected to mark exactly one runner busy")

	tag, err = pool.Exec(ctx,
		`UPDATE workflow_tasks SET status = 'assigned', runner_id = $2, assigned_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
		taskID, runnerID)
	require.NoError(t, err)
	require.Equal(t, int64(1), tag.RowsAffected(), "expected to assign exactly one task")
}

// createRunnerIntegrationRepo creates a repository for runner integration tests.
func createRunnerIntegrationRepo(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()

	ctx := context.Background()
	seq := time.Now().UnixNano()
	username := fmt.Sprintf("runnerint_user_%d", seq)
	email := fmt.Sprintf("runnerint_%d@example.com", seq)

	var userID int64
	err := pool.QueryRow(
		ctx,
		`INSERT INTO users (username, lower_username, email, lower_email, display_name)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		username,
		username,
		email,
		email,
		"Runner Integration User",
	).Scan(&userID)
	require.NoError(t, err)

	repoName := fmt.Sprintf("runnerint_repo_%d", seq)
	var repoID int64
	err = pool.QueryRow(
		ctx,
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number, next_landing_number, storage_set_id)
		 VALUES ($1, $2, $3, '', TRUE, 'main', 1, 1, 's1')
		 RETURNING id`,
		userID,
		repoName,
		repoName,
	).Scan(&repoID)
	require.NoError(t, err)
	return repoID
}

// createWorkflowRunWithDependentSteps creates a workflow run with steps that have dependencies.
// Returns the run ID, step IDs (in order: stepA, stepB, stepC), and task IDs (in order: taskA, taskB, taskC).
func createWorkflowRunWithDependentSteps(
	t *testing.T,
	queries *db.Queries,
	pool *pgxpool.Pool,
	repoID int64,
) (runID int64, stepIDs []int64, taskIDs []int64) {
	t.Helper()

	ctx := context.Background()

	// Create workflow definition with A -> B -> C dependency chain
	config := json.RawMessage(`{
		"on": {"push": {"branches": ["main"]}},
		"jobs": {
			"jobA": {"runs-on": "ubuntu", "steps": [{"name": "stepA", "run": "echo A"}]},
			"jobB": {"runs-on": "ubuntu", "needs": ["jobA"], "steps": [{"name": "stepB", "run": "echo B"}]},
			"jobC": {"runs-on": "ubuntu", "needs": ["jobB"], "steps": [{"name": "stepC", "run": "echo C"}]}
		}
	}`)

	def, err := queries.CreateWorkflowDefinition(ctx, db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "DependencyChain",
		Path:         ".smithers/workflows/chain.tsx",
		Config:       config,
	})
	require.NoError(t, err)

	// Create workflow run
	run, err := queries.CreateWorkflowRun(ctx, db.CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "running",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "abc123abc123abc123abc123abc123abc123abcd",
	})
	require.NoError(t, err)

	// Create steps
	stepA, err := queries.CreateWorkflowStep(ctx, db.CreateWorkflowStepParams{
		WorkflowRunID: run.ID,
		Name:          "stepA",
		Position:      1,
		Status:        "running",
	})
	require.NoError(t, err)

	stepB, err := queries.CreateWorkflowStep(ctx, db.CreateWorkflowStepParams{
		WorkflowRunID: run.ID,
		Name:          "stepB",
		Position:      2,
		Status:        "queued",
	})
	require.NoError(t, err)

	stepC, err := queries.CreateWorkflowStep(ctx, db.CreateWorkflowStepParams{
		WorkflowRunID: run.ID,
		Name:          "stepC",
		Position:      3,
		Status:        "queued",
	})
	require.NoError(t, err)

	// Create tasks — taskA starts as "pending" (like all new tasks)
	taskA, err := queries.CreateWorkflowTask(ctx, db.CreateWorkflowTaskParams{
		WorkflowRunID:  run.ID,
		WorkflowStepID: stepA.ID,
		RepositoryID:   repoID,
		Status:         "pending",
		Priority:       1,
		Payload:        []byte(`{"kind":"step"}`),
		AvailableAt:    time.Now().UTC(),
	})
	require.NoError(t, err)

	// Task B depends on A
	taskB, err := queries.CreateWorkflowTask(ctx, db.CreateWorkflowTaskParams{
		WorkflowRunID:  run.ID,
		WorkflowStepID: stepB.ID,
		RepositoryID:   repoID,
		Status:         "blocked",
		Priority:       1,
		Payload:        []byte(`{"kind":"step","needs":["stepA"]}`),
		AvailableAt:    time.Now().UTC(),
	})
	require.NoError(t, err)

	// Task C depends on B
	taskC, err := queries.CreateWorkflowTask(ctx, db.CreateWorkflowTaskParams{
		WorkflowRunID:  run.ID,
		WorkflowStepID: stepC.ID,
		RepositoryID:   repoID,
		Status:         "blocked",
		Priority:       1,
		Payload:        []byte(`{"kind":"step","needs":["stepB"]}`),
		AvailableAt:    time.Now().UTC(),
	})
	require.NoError(t, err)

	return run.ID, []int64{stepA.ID, stepB.ID, stepC.ID}, []int64{taskA.ID, taskB.ID, taskC.ID}
}

// TestRunnerServiceIntegration_CompleteTask_FailedSkipsDownstream verifies that when
// a task fails, all downstream dependent tasks are skipped via transitive resolution.
// This tests the service layer's progressDependencies function with a real database.
func TestRunnerServiceIntegration_CompleteTask_FailedSkipsDownstream(t *testing.T) {
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	repoID := createRunnerIntegrationRepo(t, pool)

	// Create runner
	ctx := context.Background()
	runner, err := queries.UpsertRunner(ctx, db.UpsertRunnerParams{
		Name:     "test-runner-1",
		Metadata: []byte(`{}`),
	})
	require.NoError(t, err)

	// Setup: A -> B -> C dependency chain
	_, _, taskIDs := createWorkflowRunWithDependentSteps(t, queries, pool, repoID)
	taskA, taskB, taskC := taskIDs[0], taskIDs[1], taskIDs[2]

	// Simulate claim: pending -> assigned (with runner_id)
	assignTaskToRunner(t, pool, taskA, runner.ID)

	// Mark task A as running: assigned -> running
	_, err = queries.MarkWorkflowTaskRunning(ctx, db.MarkWorkflowTaskRunningParams{
		ID:       taskA,
		RunnerID: pgtype.Int8{Int64: runner.ID, Valid: true},
	})
	require.NoError(t, err)

	svc := NewRunnerService(queries)

	// Complete task A with "failed" status
	err = svc.CompleteTask(ctx, RunnerCompleteTaskInput{
		TaskID:   taskA,
		RunnerID: runner.ID,
		Status:   "failed",
		Error:    "build failed",
	})
	require.NoError(t, err)

	// Verify task A is failed
	taskAStatus, err := getWorkflowTaskStatus(ctx, pool, taskA)
	require.NoError(t, err)
	assert.Equal(t, "failed", taskAStatus)

	// Verify task B is skipped (was blocked, depends on failed A)
	taskBStatus, err := getWorkflowTaskStatus(ctx, pool, taskB)
	require.NoError(t, err)
	assert.Equal(t, "skipped", taskBStatus, "Task B should be skipped because its dependency A failed")

	// Verify task C is also skipped (was blocked, depends on B which is now skipped)
	taskCStatus, err := getWorkflowTaskStatus(ctx, pool, taskC)
	require.NoError(t, err)
	assert.Equal(t, "skipped", taskCStatus, "Task C should be skipped because its dependency B was skipped")
}

// TestRunnerServiceIntegration_CompleteTask_SuccessUnblocksDownstream verifies that when
// a task succeeds, downstream tasks are unblocked (not skipped).
func TestRunnerServiceIntegration_CompleteTask_SuccessUnblocksDownstream(t *testing.T) {
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	repoID := createRunnerIntegrationRepo(t, pool)

	// Create runner
	ctx := context.Background()
	runner, err := queries.UpsertRunner(ctx, db.UpsertRunnerParams{
		Name:     "test-runner-2",
		Metadata: []byte(`{}`),
	})
	require.NoError(t, err)

	// Setup: A -> B -> C dependency chain
	_, _, taskIDs := createWorkflowRunWithDependentSteps(t, queries, pool, repoID)
	taskA, taskB, taskC := taskIDs[0], taskIDs[1], taskIDs[2]

	// Simulate claim: pending -> assigned (with runner_id)
	assignTaskToRunner(t, pool, taskA, runner.ID)

	// Mark task A as running: assigned -> running
	_, err = queries.MarkWorkflowTaskRunning(ctx, db.MarkWorkflowTaskRunningParams{
		ID:       taskA,
		RunnerID: pgtype.Int8{Int64: runner.ID, Valid: true},
	})
	require.NoError(t, err)

	svc := NewRunnerService(queries)

	// Complete task A with "done" status
	err = svc.CompleteTask(ctx, RunnerCompleteTaskInput{
		TaskID:   taskA,
		RunnerID: runner.ID,
		Status:   "done",
	})
	require.NoError(t, err)

	// Verify task A is done
	taskAStatus, err := getWorkflowTaskStatus(ctx, pool, taskA)
	require.NoError(t, err)
	assert.Equal(t, "done", taskAStatus)

	// Verify task B is now pending (was blocked, depends on done A)
	taskBStatus, err := getWorkflowTaskStatus(ctx, pool, taskB)
	require.NoError(t, err)
	assert.Equal(t, "pending", taskBStatus, "Task B should be pending (unblocked) because A succeeded")

	// Verify task C is still blocked (depends on B which is still pending)
	taskCStatus, err := getWorkflowTaskStatus(ctx, pool, taskC)
	require.NoError(t, err)
	assert.Equal(t, "blocked", taskCStatus, "Task C should still be blocked because B is pending")

	var runnerStatus string
	err = pool.QueryRow(ctx, `SELECT status FROM runner_pool WHERE id = $1`, runner.ID).Scan(&runnerStatus)
	require.NoError(t, err)
	assert.Equal(t, "idle", runnerStatus, "Runner should be released back to idle after task completion")
}

// TestRunnerServiceIntegration_CompleteTask_CancelledSkipsDownstream verifies that when
// a task is cancelled, all downstream dependent tasks are skipped.
func TestRunnerServiceIntegration_CompleteTask_CancelledSkipsDownstream(t *testing.T) {
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	repoID := createRunnerIntegrationRepo(t, pool)

	// Create runner
	ctx := context.Background()
	runner, err := queries.UpsertRunner(ctx, db.UpsertRunnerParams{
		Name:     "test-runner-3",
		Metadata: []byte(`{}`),
	})
	require.NoError(t, err)

	// Setup: A -> B -> C dependency chain
	_, _, taskIDs := createWorkflowRunWithDependentSteps(t, queries, pool, repoID)
	taskA, taskB, taskC := taskIDs[0], taskIDs[1], taskIDs[2]

	// Simulate claim: pending -> assigned (with runner_id)
	assignTaskToRunner(t, pool, taskA, runner.ID)

	// Mark task A as running: assigned -> running
	_, err = queries.MarkWorkflowTaskRunning(ctx, db.MarkWorkflowTaskRunningParams{
		ID:       taskA,
		RunnerID: pgtype.Int8{Int64: runner.ID, Valid: true},
	})
	require.NoError(t, err)

	svc := NewRunnerService(queries)

	// Complete task A with "cancelled" status
	err = svc.CompleteTask(ctx, RunnerCompleteTaskInput{
		TaskID:   taskA,
		RunnerID: runner.ID,
		Status:   "cancelled",
	})
	require.NoError(t, err)

	// Verify task A is cancelled
	taskAStatus, err := getWorkflowTaskStatus(ctx, pool, taskA)
	require.NoError(t, err)
	assert.Equal(t, "cancelled", taskAStatus)

	// Verify task B is skipped
	taskBStatus, err := getWorkflowTaskStatus(ctx, pool, taskB)
	require.NoError(t, err)
	assert.Equal(t, "skipped", taskBStatus, "Task B should be skipped because its dependency A was cancelled")

	// Verify task C is also skipped
	taskCStatus, err := getWorkflowTaskStatus(ctx, pool, taskC)
	require.NoError(t, err)
	assert.Equal(t, "skipped", taskCStatus, "Task C should be skipped because B was skipped")
}

// TestRunnerServiceIntegration_PoolCompleteTask_DoesNotResolveDependencies verifies that
// using RunnerPool.CompleteTask directly (bypassing the service layer) does NOT
// resolve dependencies. This documents the intentional separation of concerns:
// - RunnerPool manages task lifecycle states
// - RunnerService manages dependency resolution
func TestRunnerServiceIntegration_PoolCompleteTask_DoesNotResolveDependencies(t *testing.T) {
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	repoID := createRunnerIntegrationRepo(t, pool)

	// Create runner (needed for MarkWorkflowTaskRunning + MarkWorkflowTaskDone)
	ctx := context.Background()
	runner, err := queries.UpsertRunner(ctx, db.UpsertRunnerParams{
		Name:     "test-runner-pool",
		Metadata: []byte(`{}`),
	})
	require.NoError(t, err)

	// Setup: A -> B dependency chain
	_, _, taskIDs := createWorkflowRunWithDependentSteps(t, queries, pool, repoID)
	taskA, taskB := taskIDs[0], taskIDs[1]

	// Simulate claim: pending -> assigned (with runner_id)
	assignTaskToRunner(t, pool, taskA, runner.ID)

	// Transition task A: assigned -> running
	_, err = queries.MarkWorkflowTaskRunning(ctx, db.MarkWorkflowTaskRunningParams{
		ID:       taskA,
		RunnerID: pgtype.Int8{Int64: runner.ID, Valid: true},
	})
	require.NoError(t, err)

	// Note: We use the pool directly, NOT the service
	// This simulates a scenario where someone bypasses the service layer
	poolSvc := &runnerPoolDirect{queries: queries}

	// Complete task A with "failed" status using the pool directly
	err = poolSvc.CompleteTask(ctx, taskA, runner.ID, "failed", "")
	require.NoError(t, err)

	// Verify task A is failed
	taskAStatus, err := getWorkflowTaskStatus(ctx, pool, taskA)
	require.NoError(t, err)
	assert.Equal(t, "failed", taskAStatus)

	// Verify task B is STILL BLOCKED (not skipped) because the pool doesn't resolve dependencies
	taskBStatus, err := getWorkflowTaskStatus(ctx, pool, taskB)
	require.NoError(t, err)
	assert.Equal(t, "blocked", taskBStatus,
		"Task B should still be blocked because RunnerPool.CompleteTask does not resolve dependencies")
}

// runnerPoolDirect is a minimal implementation that simulates calling RunnerPool.CompleteTask
// directly without going through RunnerService. This documents the behavior when the
// service layer is bypassed.
type runnerPoolDirect struct {
	queries *db.Queries
}

func (p *runnerPoolDirect) CompleteTask(ctx context.Context, taskID int64, runnerID int64, status, errorMessage string) error {
	// This simulates what RunnerPool.CompleteTask does - it marks the task done and
	// releases the runner, but does not call progressDependencies.
	_, err := p.queries.MarkWorkflowTaskDone(ctx, db.MarkWorkflowTaskDoneParams{
		ID:       taskID,
		RunnerID: pgtype.Int8{Int64: runnerID, Valid: runnerID > 0},
		Status:   status,
		LastError: pgtype.Text{
			String: errorMessage,
			Valid:  errorMessage != "",
		},
	})
	if err != nil {
		return err
	}
	_, err = p.queries.ReleaseRunner(ctx, runnerID)
	return err
}

func TestRunnerServiceIntegration_StreamEvents_ConcurrentRequestsAssignContiguousSequences(t *testing.T) {
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	repoID := createRunnerIntegrationRepo(t, pool)
	ctx := context.Background()

	def, err := queries.CreateWorkflowDefinition(ctx, db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "LogRace",
		Path:         ".smithers/workflows/log-race.tsx",
		Config:       json.RawMessage(`{"on":{"push":{}},"jobs":{"build":{"runs-on":"ubuntu","steps":[{"run":"echo hi"}]}}}`),
	})
	require.NoError(t, err)

	run, err := queries.CreateWorkflowRun(ctx, db.CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "running",
		TriggerEvent:         "push",
		TriggerRef:           "refs/heads/main",
		TriggerCommitSha:     "feedfacefeedfacefeedfacefeedfacefeedface",
	})
	require.NoError(t, err)

	step, err := queries.CreateWorkflowStep(ctx, db.CreateWorkflowStepParams{
		WorkflowRunID: run.ID,
		Name:          "build",
		Position:      1,
		Status:        "running",
	})
	require.NoError(t, err)

	task, err := queries.CreateWorkflowTask(ctx, db.CreateWorkflowTaskParams{
		WorkflowRunID:  run.ID,
		WorkflowStepID: step.ID,
		RepositoryID:   repoID,
		Status:         "running",
		Priority:       1,
		Payload:        []byte(`{"job":"build","steps":[{"run":"echo hi"}]}`),
		AvailableAt:    time.Now().UTC(),
	})
	require.NoError(t, err)

	svc := NewRunnerService(queries)
	const streamCalls = 8

	start := make(chan struct{})
	var wg sync.WaitGroup
	errCh := make(chan error, streamCalls)
	for i := 0; i < streamCalls; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			errCh <- svc.StreamEvents(context.Background(), RunnerStreamEventsInput{
				TaskID: task.ID,
				Events: []RunnerEvent{
					{Type: "log", Data: json.RawMessage(fmt.Sprintf(`{"stream":"stdout","text":"line-%d"}`, i))},
				},
			})
		}(i)
	}

	close(start)
	wg.Wait()
	close(errCh)

	for err := range errCh {
		require.NoError(t, err)
	}

	rows, err := pool.Query(ctx, `
		SELECT sequence, entry
		FROM workflow_logs
		WHERE workflow_step_id = $1
		ORDER BY sequence ASC
	`, step.ID)
	require.NoError(t, err)
	defer rows.Close()

	var sequences []int64
	var entries []string
	for rows.Next() {
		var sequence int64
		var entry string
		require.NoError(t, rows.Scan(&sequence, &entry))
		sequences = append(sequences, sequence)
		entries = append(entries, entry)
	}
	require.NoError(t, rows.Err())
	require.Len(t, sequences, streamCalls)
	for i := 0; i < streamCalls; i++ {
		assert.Equal(t, int64(i+1), sequences[i])
	}
	assert.Len(t, entries, streamCalls)
}

func TestRunnerServiceIntegration_CompleteTask_UpdatesLinkedCommitStatus(t *testing.T) {
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	repoID := createRunnerIntegrationRepo(t, pool)
	ctx := context.Background()

	def, err := queries.CreateWorkflowDefinition(ctx, db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "StatusFlow",
		Path:         ".smithers/workflows/status-flow.tsx",
		Config:       json.RawMessage(`{"on":{"push":{}},"jobs":{"build":{"runs-on":"ubuntu","steps":[{"run":"echo hi"}]}}}`),
	})
	require.NoError(t, err)

	commitStatusService := NewCommitStatusService(queries)
	workflowRunService := NewWorkflowRunService(queries, WithWorkflowRunCommitStatusWriter(commitStatusService))
	results, err := workflowRunService.DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID: repoID,
		Event: TriggerEvent{
			Type:      "push",
			Ref:       "refs/heads/main",
			CommitSHA: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		},
		WorkflowDefinitionID: &def.ID,
	})
	require.NoError(t, err)
	require.Len(t, results, 1)

	runner, err := queries.UpsertRunner(ctx, db.UpsertRunnerParams{
		Name:     "status-runner",
		Metadata: []byte(`{}`),
	})
	require.NoError(t, err)

	taskID := results[0].Steps[0].TaskID
	assignTaskToRunner(t, pool, taskID, runner.ID)
	_, err = queries.MarkWorkflowTaskRunning(ctx, db.MarkWorkflowTaskRunningParams{
		ID:       taskID,
		RunnerID: pgtype.Int8{Int64: runner.ID, Valid: true},
	})
	require.NoError(t, err)

	svc := NewRunnerService(queries, WithRunnerCommitStatusWriter(commitStatusService))
	err = svc.CompleteTask(ctx, RunnerCompleteTaskInput{
		TaskID:   taskID,
		RunnerID: runner.ID,
		Status:   "done",
	})
	require.NoError(t, err)

	var status string
	err = pool.QueryRow(
		ctx,
		`SELECT status
		 FROM commit_statuses
		 WHERE workflow_run_id = $1
		 ORDER BY id DESC
		 LIMIT 1`,
		results[0].WorkflowRunID,
	).Scan(&status)
	require.NoError(t, err)
	assert.Equal(t, "success", status)
}
