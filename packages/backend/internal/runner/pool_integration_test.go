package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/deploymentdb"
)

const defaultRunnerTestDatabaseURL = "postgres://smithers:smithers@localhost:5432/smithers_test_runner?sslmode=disable"

var runnerSharedPool *pgxpool.Pool

func TestMain(m *testing.M) {
	databaseURL := os.Getenv("SMITHERS_RUNNER_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = defaultRunnerTestDatabaseURL
	}

	if err := setupRunnerIntegrationDatabase(databaseURL); err != nil {
		fmt.Fprintf(os.Stderr, "runner integration database unavailable; integration tests will be skipped: %v\n", err)
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			os.Exit(1)
		}
	}

	code := m.Run()
	if runnerSharedPool != nil {
		runnerSharedPool.Close()
	}
	os.Exit(code)
}

func setupRunnerIntegrationDatabase(databaseURL string) error {
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return fmt.Errorf("bad database URL: %w", err)
	}
	dbName := strings.TrimPrefix(parsed.Path, "/")
	adminURL := *parsed
	adminURL.Path = "/postgres"

	adminConn, err := pgx.Connect(context.Background(), adminURL.String())
	if err != nil {
		return fmt.Errorf("cannot connect to admin database: %w", err)
	}
	defer adminConn.Close(context.Background())

	var exists bool
	_ = adminConn.QueryRow(context.Background(), `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, dbName).Scan(&exists)
	if !exists {
		_, _ = adminConn.Exec(context.Background(), `CREATE DATABASE "`+strings.ReplaceAll(dbName, `"`, `""`)+`"`)
	}

	schemaBytes, err := os.ReadFile(findSchemaPath())
	if err != nil {
		return fmt.Errorf("cannot read schema: %w", err)
	}
	schemaConn, err := pgx.Connect(context.Background(), databaseURL)
	if err != nil {
		return fmt.Errorf("cannot connect to test db for schema setup: %w", err)
	}
	defer schemaConn.Close(context.Background())

	combined := `DROP SCHEMA IF EXISTS plue_storage CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;` + "\n" + string(schemaBytes)
	if _, err := schemaConn.Exec(context.Background(), combined); err != nil {
		return fmt.Errorf("schema setup failed: %w", err)
	}

	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return fmt.Errorf("bad pool config: %w", err)
	}
	cfg.MaxConns = 5
	cfg.MinConns = 1
	runnerSharedPool, err = pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		return fmt.Errorf("cannot create pool: %w", err)
	}

	return nil
}

func TestRunnerPoolIntegration_RegisterClaimReleaseLifecycle(t *testing.T) {
	q, pool := newRunnerQueries(t)
	runnerPool := NewRunnerPool(q, Config{HeartbeatTimeout: 60 * time.Second})

	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "runner-integration-lifecycle")
	task := mustCreateWorkflowTask(t, q, fixture, "pending")

	registered, err := runnerPool.registerRunner(context.Background(), RegisterRunnerInput{
		Name:     "runner-integration-lifecycle",
		Metadata: json.RawMessage(`{"labels":{"arch":"x64"}}`),
	})
	require.NoError(t, err)
	assert.Equal(t, "idle", registered.Status)

	claimed, err := runnerPool.claimRunner(context.Background(), registered.ID)
	require.NoError(t, err)
	assert.Equal(t, task.ID, claimed.ID)
	assert.Equal(t, "assigned", claimed.Status)
	assert.True(t, claimed.RunnerID.Valid)
	assert.Equal(t, registered.ID, claimed.RunnerID.Int64)

	var runnerStatus string
	err = pool.QueryRow(context.Background(), `SELECT status FROM runner_pool WHERE id = $1`, registered.ID).Scan(&runnerStatus)
	require.NoError(t, err)
	assert.Equal(t, "busy", runnerStatus)

	err = runnerPool.releaseRunner(context.Background(), registered.ID)
	require.NoError(t, err)

	err = pool.QueryRow(context.Background(), `SELECT status FROM runner_pool WHERE id = $1`, registered.ID).Scan(&runnerStatus)
	require.NoError(t, err)
	assert.Equal(t, "busy", runnerStatus, "an assigned task must prevent early runner release")

	require.NoError(t, runnerPool.markTaskRunning(context.Background(), task.ID, registered.ID))
	require.NoError(t, runnerPool.CompleteTask(context.Background(), task.ID, registered.ID, "done", ""))
	err = pool.QueryRow(context.Background(), `SELECT status FROM runner_pool WHERE id = $1`, registered.ID).Scan(&runnerStatus)
	require.NoError(t, err)
	assert.Equal(t, "idle", runnerStatus)
}

func TestRunnerPoolIntegration_CleanupStaleRunners_RequeuesTasks(t *testing.T) {
	q, pool := newRunnerQueries(t)
	runnerPool := NewRunnerPool(q, Config{HeartbeatTimeout: 60 * time.Second})

	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "runner-integration-stale")
	task := mustCreateWorkflowTask(t, q, fixture, "pending")

	registered, err := runnerPool.registerRunner(context.Background(), RegisterRunnerInput{
		Name:     "runner-integration-stale",
		Metadata: json.RawMessage(`{"labels":{"zone":"a"}}`),
	})
	require.NoError(t, err)

	claimed, err := runnerPool.claimRunner(context.Background(), registered.ID)
	require.NoError(t, err)
	assert.Equal(t, task.ID, claimed.ID)

	require.NoError(t, runnerPool.markTaskRunning(context.Background(), claimed.ID, registered.ID))

	staleHeartbeat := time.Now().UTC().Add(-3 * time.Minute)
	_, err = pool.Exec(
		context.Background(),
		`UPDATE runner_pool
		 SET last_heartbeat_at = $2, updated_at = NOW()
		 WHERE id = $1`,
		registered.ID,
		staleHeartbeat,
	)
	require.NoError(t, err)

	cleanupStartedAt := time.Now().UTC()
	cleaned, err := runnerPool.cleanupStaleRunners(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 1, cleaned)

	var runnerStatus string
	err = pool.QueryRow(context.Background(), `SELECT status FROM runner_pool WHERE id = $1`, registered.ID).Scan(&runnerStatus)
	require.NoError(t, err)
	assert.Equal(t, "offline", runnerStatus)

	var taskStatus string
	var runnerID pgtype.Int8
	var assignedAt pgtype.Timestamptz
	var startedAt pgtype.Timestamptz
	var availableAt time.Time
	err = pool.QueryRow(
		context.Background(),
		`SELECT status, runner_id, assigned_at, started_at, available_at
		 FROM workflow_tasks
		 WHERE id = $1`,
		task.ID,
	).Scan(&taskStatus, &runnerID, &assignedAt, &startedAt, &availableAt)
	require.NoError(t, err)

	assert.Equal(t, "pending", taskStatus)
	assert.False(t, runnerID.Valid)
	assert.False(t, assignedAt.Valid)
	assert.False(t, startedAt.Valid)
	assert.True(t, availableAt.After(cleanupStartedAt))

	var stepStatus string
	var stepStartedAt pgtype.Timestamptz
	err = pool.QueryRow(
		context.Background(),
		`SELECT status, started_at
		 FROM workflow_steps
		 WHERE id = $1`,
		fixture.stepID,
	).Scan(&stepStatus, &stepStartedAt)
	require.NoError(t, err)
	assert.Equal(t, "queued", stepStatus)
	assert.False(t, stepStartedAt.Valid)
}

func TestRunnerPoolIntegration_HeartbeatAndTaskTransitions(t *testing.T) {
	q, pool := newRunnerQueries(t)
	runnerPool := NewRunnerPool(q, Config{HeartbeatTimeout: 60 * time.Second})

	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "runner-integration-heartbeat")
	_ = mustCreateWorkflowTask(t, q, fixture, "pending")

	registered, err := runnerPool.registerRunner(context.Background(), RegisterRunnerInput{
		Name:     "runner-integration-heartbeat",
		Metadata: json.RawMessage(`{"labels":{"rack":"r1"}}`),
	})
	require.NoError(t, err)

	var beforeHeartbeat pgtype.Timestamptz
	err = pool.QueryRow(context.Background(), `SELECT last_heartbeat_at FROM runner_pool WHERE id = $1`, registered.ID).Scan(&beforeHeartbeat)
	require.NoError(t, err)
	require.True(t, beforeHeartbeat.Valid)

	task, err := runnerPool.claimRunner(context.Background(), registered.ID)
	require.NoError(t, err)

	// Sleep a moment to avoid same-timestamp flake when DB rounds to microseconds.
	time.Sleep(5 * time.Millisecond)
	require.NoError(t, runnerPool.heartbeatRunner(context.Background(), registered.ID))

	var afterHeartbeat pgtype.Timestamptz
	err = pool.QueryRow(context.Background(), `SELECT last_heartbeat_at FROM runner_pool WHERE id = $1`, registered.ID).Scan(&afterHeartbeat)
	require.NoError(t, err)
	require.True(t, afterHeartbeat.Valid)
	assert.True(t, afterHeartbeat.Time.After(beforeHeartbeat.Time) || afterHeartbeat.Time.Equal(beforeHeartbeat.Time))

	require.NoError(t, runnerPool.markTaskRunning(context.Background(), task.ID, registered.ID))
	require.NoError(t, runnerPool.markTaskDone(context.Background(), task.ID, registered.ID, "done", ""))

	var taskStatus string
	var finishedAt pgtype.Timestamptz
	err = pool.QueryRow(
		context.Background(),
		`SELECT status, finished_at FROM workflow_tasks WHERE id = $1`,
		task.ID,
	).Scan(&taskStatus, &finishedAt)
	require.NoError(t, err)
	assert.Equal(t, "done", taskStatus)
	assert.True(t, finishedAt.Valid)
}

func TestRunnerPoolIntegration_CompleteTask_WithValidRunnerID(t *testing.T) {
	q, pool := newRunnerQueries(t)
	runnerPool := NewRunnerPool(q, Config{HeartbeatTimeout: 60 * time.Second})

	firstFixture := mustCreateWorkflowTaskFixture(t, q, pool, "runner-complete-task-first")
	firstTask := mustCreateWorkflowTask(t, q, firstFixture, "pending")

	registered, err := runnerPool.registerRunner(context.Background(), RegisterRunnerInput{
		Name:     "runner-complete-task",
		Metadata: json.RawMessage(`{}`),
	})
	require.NoError(t, err)

	claimed, err := runnerPool.claimRunner(context.Background(), registered.ID)
	require.NoError(t, err)
	assert.Equal(t, firstTask.ID, claimed.ID)

	require.NoError(t, runnerPool.markTaskRunning(context.Background(), claimed.ID, registered.ID))

	err = runnerPool.CompleteTask(context.Background(), claimed.ID, registered.ID, "done", "")
	require.NoError(t, err)

	var taskStatus string
	err = pool.QueryRow(context.Background(), `SELECT status FROM workflow_tasks WHERE id = $1`, firstTask.ID).Scan(&taskStatus)
	require.NoError(t, err)
	assert.Equal(t, "done", taskStatus)

	var runnerStatus string
	err = pool.QueryRow(context.Background(), `SELECT status FROM runner_pool WHERE id = $1`, registered.ID).Scan(&runnerStatus)
	require.NoError(t, err)
	assert.Equal(t, "idle", runnerStatus)

	secondFixture := mustCreateWorkflowTaskFixture(t, q, pool, "runner-complete-task-second")
	secondTask := mustCreateWorkflowTask(t, q, secondFixture, "pending")

	claimedAgain, err := runnerPool.claimRunner(context.Background(), registered.ID)
	require.NoError(t, err)
	assert.Equal(t, secondTask.ID, claimedAgain.ID)
}

func TestRunnerPoolIntegration_MarkTaskTransitions_UpdateWorkflowStepStatus(t *testing.T) {
	q, pool := newRunnerQueries(t)
	runnerPool := NewRunnerPool(q, Config{HeartbeatTimeout: 60 * time.Second})

	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "runner-step-status")
	task := mustCreateWorkflowTask(t, q, fixture, "pending")

	registered, err := runnerPool.registerRunner(context.Background(), RegisterRunnerInput{
		Name:     "runner-step-status",
		Metadata: json.RawMessage(`{}`),
	})
	require.NoError(t, err)

	claimed, err := runnerPool.claimRunner(context.Background(), registered.ID)
	require.NoError(t, err)
	assert.Equal(t, task.ID, claimed.ID)

	require.NoError(t, runnerPool.markTaskRunning(context.Background(), claimed.ID, registered.ID))

	var runningStepStatus string
	err = pool.QueryRow(context.Background(), `SELECT status FROM workflow_steps WHERE id = $1`, fixture.stepID).Scan(&runningStepStatus)
	require.NoError(t, err)
	assert.Equal(t, "running", runningStepStatus)

	require.NoError(t, runnerPool.markTaskDone(context.Background(), claimed.ID, registered.ID, "done", ""))

	var completedStepStatus string
	err = pool.QueryRow(context.Background(), `SELECT status FROM workflow_steps WHERE id = $1`, fixture.stepID).Scan(&completedStepStatus)
	require.NoError(t, err)
	assert.Equal(t, "success", completedStepStatus)
}

func findSchemaPath() string {
	candidates := []string{
		filepath.Join("..", "..", "db", "cluster", "sqlc_schema.sql"),
		filepath.Join("db", "cluster", "sqlc_schema.sql"),
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return candidates[0]
}

func truncateRunnerTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	_, err := pool.Exec(context.Background(), `
		TRUNCATE
			agent_parts,
			agent_messages,
			agent_sessions,
			webhook_deliveries,
			webhooks,
			watches,
			stars,
			notifications,
			commit_statuses,
			workflow_logs,
			workflow_tasks,
			workflow_steps,
			workflow_runs,
			workflow_schedule_specs,
			workflow_definitions,
			runner_pool,
			reactions,
			mentions,
			protected_bookmarks,
			jj_operations,
			conflicts,
			changes,
			bookmarks,
			landing_request_comments,
			landing_request_reviews,
			landing_request_changes,
			landing_requests,
			landing_tasks,
			pinned_issues,
			issue_dependencies,
			issue_events,
			issue_assignees,
			issue_labels,
			issue_comments,
			labels,
			issues,
			milestones,
			lfs_locks,
			lfs_meta_objects,
			lfs_objects,
			collaborators,
			team_repos,
			team_members,
			teams,
			org_members,
			email_verification_tokens,
			oauth_accounts,
			ssh_keys,
			access_tokens,
			email_addresses,
			auth_sessions,
			oauth_states,
			auth_nonces,
			code_search_documents,
			search_rate_limits,
			repositories,
			organizations,
			users
		RESTART IDENTITY CASCADE
	`)
	require.NoError(t, err)
}

func newRunnerQueries(t *testing.T) (*deploymentdb.Queries, *pgxpool.Pool) {
	t.Helper()
	if runnerSharedPool == nil {
		t.Skip("postgres unavailable for runner integration tests")
	}
	truncateRunnerTables(t, runnerSharedPool)
	return deploymentdb.New(runnerSharedPool), runnerSharedPool
}

type workflowTaskFixture struct {
	repoID int64
	runID  int64
	stepID int64
}

func mustCreateWorkflowTaskFixture(t *testing.T, q *deploymentdb.Queries, pool *pgxpool.Pool, prefix string) workflowTaskFixture {
	t.Helper()

	userID := mustCreateUser(t, pool, prefix+"-user")
	repoID := mustCreateRepo(t, pool, userID, prefix+"-repo")

	cfg := []byte(`{"triggers":[{"type":"push"}],"steps":[{"name":"test","run":"make test"}]}`)
	def, err := q.CreateWorkflowDefinition(context.Background(), db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Workflow",
		Path:         ".smithers/workflows/test.tsx",
		Config:       cfg,
	})
	require.NoError(t, err)

	run, err := q.CreateWorkflowRun(context.Background(), db.CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "queued",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "sha-task-fixture",
	})
	require.NoError(t, err)

	step, err := q.CreateWorkflowStep(context.Background(), db.CreateWorkflowStepParams{
		WorkflowRunID: run.ID,
		Name:          "test",
		Position:      1,
		Status:        "queued",
	})
	require.NoError(t, err)

	return workflowTaskFixture{
		repoID: repoID,
		runID:  run.ID,
		stepID: step.ID,
	}
}

func mustCreateWorkflowTask(t *testing.T, q *deploymentdb.Queries, fixture workflowTaskFixture, status string) db.WorkflowTask {
	t.Helper()

	task, err := q.CreateWorkflowTask(context.Background(), db.CreateWorkflowTaskParams{
		WorkflowRunID:  fixture.runID,
		WorkflowStepID: fixture.stepID,
		RepositoryID:   fixture.repoID,
		Status:         status,
		Priority:       1,
		Payload:        []byte(`{"kind":"step"}`),
		AvailableAt:    time.Now().UTC().Add(-1 * time.Second),
	})
	require.NoError(t, err)
	return task
}

func mustCreateUser(t *testing.T, pool *pgxpool.Pool, username string) int64 {
	t.Helper()

	lowerUsername := strings.ToLower(username)

	var id int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO users (username, lower_username, email, display_name) VALUES ($1, $2, $3, $4) RETURNING id`,
		username,
		lowerUsername,
		username+"@example.com",
		username,
	).Scan(&id)
	require.NoError(t, err)

	return id
}

func mustCreateRepo(t *testing.T, pool *pgxpool.Pool, userID int64, name string) int64 {
	t.Helper()

	lowerName := strings.ToLower(name)

	var id int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number) VALUES ($1, $2, $3, '', TRUE, 'main', 1) RETURNING id`,
		userID,
		name,
		lowerName,
	).Scan(&id)
	require.NoError(t, err)

	return id
}

func runnerParam(runnerID int64) pgtype.Int8 {
	return pgtype.Int8{Int64: runnerID, Valid: true}
}

// TestRunnerPoolIntegration_CompleteTask_DoesNotResolveDependencies verifies that the
// RunnerPool.CompleteTask method does NOT resolve dependencies. This is intentional -
// dependency resolution is handled by the service layer (RunnerService.progressDependencies).
// This test documents the expected behavior: when using the pool directly, downstream
// blocked tasks remain blocked regardless of task completion status.
func TestRunnerPoolIntegration_CompleteTask_DoesNotResolveDependencies(t *testing.T) {
	q, pool := newRunnerQueries(t)
	runnerPool := NewRunnerPool(q, Config{HeartbeatTimeout: 60 * time.Second})
	ctx := context.Background()

	// Create user and repo
	userID := mustCreateUser(t, pool, "pool-dep-test-user")
	repoID := mustCreateRepo(t, pool, userID, "pool-dep-test-repo")

	// Create workflow definition with dependent jobs: build -> test
	cfg := []byte(`{"triggers":[{"type":"push"}],"jobs":{"build":{"runs-on":"ubuntu","steps":[{"run":"make build"}]},"test":{"runs-on":"ubuntu","needs":["build"],"steps":[{"run":"make test"}]}}}`)
	def, err := q.CreateWorkflowDefinition(ctx, db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "DepTestWorkflow",
		Path:         ".smithers/workflows/dep-test.tsx",
		Config:       cfg,
	})
	require.NoError(t, err)

	// Create workflow run
	run, err := q.CreateWorkflowRun(ctx, db.CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "running",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "abc123",
	})
	require.NoError(t, err)

	// Create workflow steps
	buildStep, err := q.CreateWorkflowStep(ctx, db.CreateWorkflowStepParams{
		WorkflowRunID: run.ID,
		Name:          "build",
		Position:      1,
		Status:        "queued",
	})
	require.NoError(t, err)

	testStep, err := q.CreateWorkflowStep(ctx, db.CreateWorkflowStepParams{
		WorkflowRunID: run.ID,
		Name:          "test",
		Position:      2,
		Status:        "queued",
	})
	require.NoError(t, err)

	// Create tasks: build starts as pending, test is blocked (depends on build)
	buildTask, err := q.CreateWorkflowTask(ctx, db.CreateWorkflowTaskParams{
		WorkflowRunID:  run.ID,
		WorkflowStepID: buildStep.ID,
		RepositoryID:   repoID,
		Status:         "pending",
		Priority:       1,
		Payload:        []byte(`{"kind":"step","job":"build"}`),
		AvailableAt:    time.Now().UTC(),
	})
	require.NoError(t, err)

	testTask, err := q.CreateWorkflowTask(ctx, db.CreateWorkflowTaskParams{
		WorkflowRunID:  run.ID,
		WorkflowStepID: testStep.ID,
		RepositoryID:   repoID,
		Status:         "blocked",
		Priority:       1,
		Payload:        []byte(`{"kind":"step","job":"test","needs":["build"]}`),
		AvailableAt:    time.Now().UTC(),
	})
	require.NoError(t, err)

	// Create and register a runner
	registered, err := runnerPool.registerRunner(ctx, RegisterRunnerInput{
		Name:     "pool-dep-test-runner",
		Metadata: json.RawMessage(`{}`),
	})
	require.NoError(t, err)

	// Simulate claim: pending -> assigned (with runner_id)
	_, err = pool.Exec(ctx,
		`UPDATE workflow_tasks SET status = 'assigned', runner_id = $2, assigned_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
		buildTask.ID, registered.ID)
	require.NoError(t, err)

	// Mark the build task as running: assigned -> running
	_, err = q.MarkWorkflowTaskRunning(ctx, db.MarkWorkflowTaskRunningParams{
		ID:       buildTask.ID,
		RunnerID: runnerParam(registered.ID),
	})
	require.NoError(t, err)

	// Complete the build task using the POOL (not the service)
	// The pool's CompleteTask should NOT resolve dependencies
	err = runnerPool.CompleteTask(ctx, buildTask.ID, registered.ID, "done", "")
	require.NoError(t, err)

	// Verify build task is done
	var buildStatus string
	err = pool.QueryRow(ctx, `SELECT status FROM workflow_tasks WHERE id = $1`, buildTask.ID).Scan(&buildStatus)
	require.NoError(t, err)
	assert.Equal(t, "done", buildStatus)

	// Verify test task is STILL BLOCKED (pool does not resolve dependencies)
	// This is the expected behavior - dependency resolution is handled by the service layer
	var testStatus string
	err = pool.QueryRow(ctx, `SELECT status FROM workflow_tasks WHERE id = $1`, testTask.ID).Scan(&testStatus)
	require.NoError(t, err)
	assert.Equal(t, "blocked", testStatus, "Pool CompleteTask should NOT resolve dependencies - test task should remain blocked")
}
