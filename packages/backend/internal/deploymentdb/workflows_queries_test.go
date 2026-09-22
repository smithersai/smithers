package deploymentdb

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCreateWorkflowDefinition_JSONBShape(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "workflow-user")
	repoID := mustCreateRepo(t, pool, userID, "workflow-repo")

	cfg, err := json.Marshal(map[string]any{
		"triggers": []map[string]any{{"type": "push"}},
		"steps":    []map[string]any{{"name": "test", "run": "go test ./..."}},
	})
	require.NoError(t, err)

	def, err := q.CreateWorkflowDefinition(context.Background(), CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "CI",
		Path:         ".smithers/workflows/ci.tsx",
		Config:       cfg,
	})
	require.NoError(t, err)
	assert.Equal(t, repoID, def.RepositoryID)

	_, err = q.CreateWorkflowDefinition(context.Background(), CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Bad",
		Path:         ".smithers/workflows/bad.tsx",
		Config:       []byte(`[]`),
	})
	require.Error(t, err)
}

func TestCreateWorkflowRunAndSteps(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "workflow-run-user")
	repoID := mustCreateRepo(t, pool, userID, "workflow-run-repo")
	cfg := []byte(`{"triggers":[{"type":"push"}],"steps":[{"name":"build","run":"make build"}]}`)

	def, err := q.CreateWorkflowDefinition(context.Background(), CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Build",
		Path:         ".smithers/workflows/build.tsx",
		Config:       cfg,
	})
	require.NoError(t, err)

	run, err := q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "queued",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "abc123",
	})
	require.NoError(t, err)
	assert.Equal(t, "queued", run.Status)

	step, err := q.CreateWorkflowStep(context.Background(), CreateWorkflowStepParams{
		WorkflowRunID: run.ID,
		Name:          "build",
		Position:      1,
		Status:        "queued",
	})
	require.NoError(t, err)
	assert.Equal(t, run.ID, step.WorkflowRunID)

	otherUserID := mustCreateUser(t, pool, "workflow-run-other-user")
	otherRepoID := mustCreateRepo(t, pool, otherUserID, "workflow-run-other-repo")
	_, err = q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
		RepositoryID:         otherRepoID,
		WorkflowDefinitionID: def.ID,
		Status:               "queued",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "wrong-repo",
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	_, err = q.CreateWorkflowTask(context.Background(), CreateWorkflowTaskParams{
		WorkflowRunID:  run.ID,
		WorkflowStepID: step.ID,
		RepositoryID:   otherRepoID,
		Status:         "pending",
		Priority:       1,
		Payload:        []byte(`{"kind":"wrong-repo"}`),
		AvailableAt:    time.Now().UTC(),
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	validTask, err := q.CreateWorkflowTask(context.Background(), CreateWorkflowTaskParams{
		WorkflowRunID:  run.ID,
		WorkflowStepID: step.ID,
		RepositoryID:   repoID,
		Status:         "pending",
		Priority:       1,
		Payload:        []byte(`{"kind":"valid"}`),
		AvailableAt:    time.Now().UTC(),
	})
	require.NoError(t, err)
	mustExec(t, pool, `UPDATE workflow_tasks SET repository_id = $2 WHERE id = $1`, validTask.ID, otherRepoID)
	var derivedRepoID int64
	err = pool.QueryRow(context.Background(), `SELECT repository_id FROM workflow_tasks WHERE id = $1`, validTask.ID).Scan(&derivedRepoID)
	require.NoError(t, err)
	assert.Equal(t, repoID, derivedRepoID)

	secondRun, err := q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "queued",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "second-run",
	})
	require.NoError(t, err)
	secondStep, err := q.CreateWorkflowStep(context.Background(), CreateWorkflowStepParams{
		WorkflowRunID: secondRun.ID,
		Name:          "test",
		Position:      1,
		Status:        "queued",
	})
	require.NoError(t, err)
	_, err = q.CreateWorkflowTask(context.Background(), CreateWorkflowTaskParams{
		WorkflowRunID:  run.ID,
		WorkflowStepID: secondStep.ID,
		RepositoryID:   repoID,
		Status:         "pending",
		Priority:       1,
		Payload:        []byte(`{"kind":"wrong-run"}`),
		AvailableAt:    time.Now().UTC(),
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_ = mustExpectError(t, pool, func(sp DBTX) error {
		_, updateErr := sp.Exec(context.Background(), `UPDATE workflow_tasks SET workflow_run_id = $2 WHERE id = $1`, validTask.ID, secondRun.ID)
		return updateErr
	})
}

func TestGetWorkflowRunByRunID_ReturnsRun(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "workflow-run-by-id-user")
	repoID := mustCreateRepo(t, pool, userID, "workflow-run-by-id-repo")
	cfg := []byte(`{"triggers":[{"type":"push"}],"steps":[{"name":"build","run":"make build"}]}`)

	def, err := q.CreateWorkflowDefinition(context.Background(), CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Build",
		Path:         ".smithers/workflows/build.tsx",
		Config:       cfg,
	})
	require.NoError(t, err)

	run, err := q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "queued",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "abc123",
	})
	require.NoError(t, err)

	got, err := q.GetWorkflowRunByRunID(context.Background(), run.ID)
	require.NoError(t, err)
	assert.Equal(t, run.ID, got.ID)
	assert.Equal(t, run.RepositoryID, got.RepositoryID)
	assert.Equal(t, run.WorkflowDefinitionID, got.WorkflowDefinitionID)
	assert.Equal(t, run.Status, got.Status)
	assert.Equal(t, run.TriggerEvent, got.TriggerEvent)
	assert.Equal(t, run.TriggerRef, got.TriggerRef)
	assert.Equal(t, run.TriggerCommitSha, got.TriggerCommitSha)
}

func TestClaimPendingTask_PriorityThenCreatedAtOrder(t *testing.T) {
	// ClaimPendingTask uses FOR UPDATE SKIP LOCKED which requires committed data
	// visible across separate connections. Use sharedPool directly.
	seq := testSeqCounter.Add(1)
	poolQ := New(sharedPool)
	fixture := mustCreateWorkflowTaskFixture(t, poolQ, sharedPool, fmt.Sprintf("workflow-claim-order-%d", seq))
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_tasks WHERE step_id = $1`, fixture.stepID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_steps WHERE run_id = $1`, fixture.runID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_runs WHERE id = $1`, fixture.runID)
	})

	t1 := mustCreateWorkflowTask(t, poolQ, fixture, "pending")
	t2 := mustCreateWorkflowTask(t, poolQ, fixture, "pending")
	t3 := mustCreateWorkflowTask(t, poolQ, fixture, "pending")
	t4 := mustCreateWorkflowTask(t, poolQ, fixture, "pending")

	baseTime := time.Now().UTC().Add(-10 * time.Minute).Truncate(time.Microsecond)
	mustSetTaskPriorityAndCreatedAt(t, sharedPool, t1.ID, 3, baseTime.Add(-2*time.Minute))
	mustSetTaskPriorityAndCreatedAt(t, sharedPool, t2.ID, 3, baseTime.Add(-1*time.Minute))
	mustSetTaskPriorityAndCreatedAt(t, sharedPool, t3.ID, 3, baseTime.Add(-1*time.Minute))
	mustSetTaskPriorityAndCreatedAt(t, sharedPool, t4.ID, 1, baseTime.Add(-20*time.Minute))

	r1 := mustCreateRunner(t, sharedPool, fmt.Sprintf("claim-order-runner-1-%d", seq))
	r2 := mustCreateRunner(t, sharedPool, fmt.Sprintf("claim-order-runner-2-%d", seq))
	r3 := mustCreateRunner(t, sharedPool, fmt.Sprintf("claim-order-runner-3-%d", seq))
	r4 := mustCreateRunner(t, sharedPool, fmt.Sprintf("claim-order-runner-4-%d", seq))
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM runner_pool WHERE id IN ($1, $2, $3, $4)`, r1, r2, r3, r4)
	})

	firstClaim, err := poolQ.ClaimPendingTask(context.Background(), runnerParam(r1))
	require.NoError(t, err)
	secondClaim, err := poolQ.ClaimPendingTask(context.Background(), runnerParam(r2))
	require.NoError(t, err)
	thirdClaim, err := poolQ.ClaimPendingTask(context.Background(), runnerParam(r3))
	require.NoError(t, err)
	fourthClaim, err := poolQ.ClaimPendingTask(context.Background(), runnerParam(r4))
	require.NoError(t, err)

	assert.Equal(t, []int64{t1.ID, t2.ID, t3.ID, t4.ID}, []int64{firstClaim.ID, secondClaim.ID, thirdClaim.ID, fourthClaim.ID})
}

func TestClaimPendingTask_SkipsLockedRows(t *testing.T) {
	// FOR UPDATE SKIP LOCKED requires separate database connections (not savepoints
	// within the same transaction), so this test uses sharedPool directly.
	seq := testSeqCounter.Add(1)
	poolQ := New(sharedPool)
	fixture := mustCreateWorkflowTaskFixture(t, poolQ, sharedPool, fmt.Sprintf("workflow-claim-lock-%d", seq))
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_tasks WHERE step_id = $1`, fixture.stepID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_steps WHERE run_id = $1`, fixture.runID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_runs WHERE id = $1`, fixture.runID)
	})

	first := mustCreateWorkflowTask(t, poolQ, fixture, "pending")
	second := mustCreateWorkflowTask(t, poolQ, fixture, "pending")

	baseTime := time.Now().UTC().Add(-5 * time.Minute).Truncate(time.Microsecond)
	mustSetTaskPriorityAndCreatedAt(t, sharedPool, first.ID, 3, baseTime.Add(-1*time.Minute))
	mustSetTaskPriorityAndCreatedAt(t, sharedPool, second.ID, 2, baseTime)

	// Lock the first task from a separate connection.
	tx, err := sharedPool.Begin(context.Background())
	require.NoError(t, err)
	defer tx.Rollback(context.Background())

	var lockedID int64
	err = tx.QueryRow(context.Background(), `SELECT id FROM workflow_tasks WHERE id = $1 FOR UPDATE`, first.ID).Scan(&lockedID)
	require.NoError(t, err)

	runnerID := mustCreateRunner(t, sharedPool, fmt.Sprintf("claim-lock-runner-%d", seq))
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM runner_pool WHERE id = $1`, runnerID)
	})

	claimed, err := poolQ.ClaimPendingTask(context.Background(), runnerParam(runnerID))
	require.NoError(t, err)
	assert.Equal(t, second.ID, claimed.ID)
}

func TestClaimPendingTask_SetsRunnerIDAndAssignedAt(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-claim-assignment")

	task := mustCreateWorkflowTask(t, q, fixture, "pending")
	runnerID := mustCreateRunner(t, pool, "claim-assignment-runner")

	claimed, err := q.ClaimPendingTask(context.Background(), runnerParam(runnerID))
	require.NoError(t, err)

	assert.Equal(t, task.ID, claimed.ID)
	assert.Equal(t, "assigned", claimed.Status)
	assert.Equal(t, int32(1), claimed.Attempt)
	assert.True(t, claimed.RunnerID.Valid)
	assert.Equal(t, runnerID, claimed.RunnerID.Int64)
	assert.True(t, claimed.AssignedAt.Valid)
}

func TestNotifyWorkflowRunEvent_Executes(t *testing.T) {
	seq := testSeqCounter.Add(1)
	poolQ := New(sharedPool)
	fixture := mustCreateWorkflowTaskFixture(t, poolQ, sharedPool, fmt.Sprintf("workflow-run-notify-%d", seq))
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_tasks WHERE step_id = $1`, fixture.stepID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_steps WHERE run_id = $1`, fixture.runID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_runs WHERE id = $1`, fixture.runID)
	})

	channel := "workflow_run_events_" + strconv.FormatInt(fixture.runID, 10)
	payload := `{"run_id":123,"source":"test"}`

	listenerConn, err := sharedPool.Acquire(context.Background())
	require.NoError(t, err)
	defer listenerConn.Release()

	_, err = listenerConn.Exec(context.Background(), "LISTEN "+channel)
	require.NoError(t, err)

	err = poolQ.NotifyWorkflowRunEvent(context.Background(), NotifyWorkflowRunEventParams{
		RunID:   fixture.runID,
		Payload: payload,
	})
	require.NoError(t, err)

	waitCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	notification, err := listenerConn.Conn().WaitForNotification(waitCtx)
	require.NoError(t, err)
	assert.Equal(t, channel, notification.Channel)
	assert.Equal(t, payload, notification.Payload)
}

func TestClaimPendingTask_EmptyQueueReturnsNoRows(t *testing.T) {
	q, pool := newQueries(t)
	runnerID := mustCreateRunner(t, pool, "claim-empty-runner")

	// Drain any existing pending tasks created by other concurrent tests
	for {
		_, err := q.ClaimPendingTask(context.Background(), runnerParam(runnerID))
		if err != nil {
			require.ErrorIs(t, err, pgx.ErrNoRows)
			break
		}
	}
}

func TestClaimPendingTask_RespectsAvailableAt(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-claim-available-at")

	now := time.Now().UTC()
	futureTask, err := q.CreateWorkflowTask(context.Background(), CreateWorkflowTaskParams{
		WorkflowRunID:  fixture.runID,
		WorkflowStepID: fixture.stepID,
		RepositoryID:   fixture.repoID,
		Status:         "pending",
		Priority:       3,
		Payload:        []byte(`{"kind":"step"}`),
		AvailableAt:    now.Add(10 * time.Minute),
	})
	require.NoError(t, err)

	currentTask, err := q.CreateWorkflowTask(context.Background(), CreateWorkflowTaskParams{
		WorkflowRunID:  fixture.runID,
		WorkflowStepID: fixture.stepID,
		RepositoryID:   fixture.repoID,
		Status:         "pending",
		Priority:       1,
		Payload:        []byte(`{"kind":"step"}`),
		AvailableAt:    now.Add(-1 * time.Minute),
	})
	require.NoError(t, err)

	runnerID := mustCreateRunner(t, pool, "claim-available-at-runner")
	claimed, err := q.ClaimPendingTask(context.Background(), runnerParam(runnerID))
	require.NoError(t, err)
	assert.Equal(t, currentTask.ID, claimed.ID)

	var status string
	err = pool.QueryRow(context.Background(), `SELECT status FROM workflow_tasks WHERE id = $1`, futureTask.ID).Scan(&status)
	require.NoError(t, err)
	assert.Equal(t, "pending", status)
}

func TestGetClaimableWorkflowTaskBacklog_CountsOnlyClaimablePendingTasks(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-task-backlog")

	now := time.Now().UTC()

	claimableOldest := mustCreateWorkflowTask(t, q, fixture, "pending")
	claimableNewest := mustCreateWorkflowTask(t, q, fixture, "pending")
	delayed := mustCreateWorkflowTask(t, q, fixture, "pending")
	assigned := mustCreateWorkflowTask(t, q, fixture, "assigned")
	running := mustCreateWorkflowTask(t, q, fixture, "running")
	done := mustCreateWorkflowTask(t, q, fixture, "done")
	failed := mustCreateWorkflowTask(t, q, fixture, "failed")

	mustSetWorkflowTaskState(t, pool, claimableOldest.ID, "pending", now.Add(-90*time.Second))
	mustSetWorkflowTaskState(t, pool, claimableNewest.ID, "pending", now.Add(-30*time.Second))
	mustSetWorkflowTaskState(t, pool, delayed.ID, "pending", now.Add(10*time.Minute))
	mustSetWorkflowTaskState(t, pool, assigned.ID, "assigned", now.Add(-5*time.Minute))
	mustSetWorkflowTaskState(t, pool, running.ID, "running", now.Add(-5*time.Minute))
	mustSetWorkflowTaskState(t, pool, done.ID, "done", now.Add(-5*time.Minute))
	mustSetWorkflowTaskState(t, pool, failed.ID, "failed", now.Add(-5*time.Minute))

	// A pending task on a sandbox-plane run is never claimable by the runner
	// pool, so it must not count toward the runner backlog either.
	sandboxFixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-task-backlog-sandbox", "sandbox")
	sandboxTask := mustCreateWorkflowTask(t, q, sandboxFixture, "pending")
	mustSetWorkflowTaskState(t, pool, sandboxTask.ID, "pending", now.Add(-10*time.Minute))

	backlog, err := q.GetClaimableWorkflowTaskBacklog(context.Background())
	require.NoError(t, err)

	assert.Equal(t, int64(2), backlog.Depth)
	assert.InDelta(t, 90, backlog.OldestAgeSeconds, 5)
}

func TestGetClaimableWorkflowTaskBacklog_ReturnsZeroWhenNothingClaimable(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-task-backlog-empty")

	now := time.Now().UTC()

	delayed := mustCreateWorkflowTask(t, q, fixture, "pending")
	assigned := mustCreateWorkflowTask(t, q, fixture, "assigned")
	running := mustCreateWorkflowTask(t, q, fixture, "running")
	done := mustCreateWorkflowTask(t, q, fixture, "done")

	mustSetWorkflowTaskState(t, pool, delayed.ID, "pending", now.Add(10*time.Minute))
	mustSetWorkflowTaskState(t, pool, assigned.ID, "assigned", now.Add(-2*time.Minute))
	mustSetWorkflowTaskState(t, pool, running.ID, "running", now.Add(-2*time.Minute))
	mustSetWorkflowTaskState(t, pool, done.ID, "done", now.Add(-2*time.Minute))

	backlog, err := q.GetClaimableWorkflowTaskBacklog(context.Background())
	require.NoError(t, err)

	assert.Zero(t, backlog.Depth)
	assert.Zero(t, backlog.OldestAgeSeconds)
}

func TestClaimPendingTask_SkipsTerminalParentRuns(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-task-terminal-parent")
	task := mustCreateWorkflowTask(t, q, fixture, "pending")
	mustSetWorkflowTaskState(t, pool, task.ID, "pending", time.Now().UTC().Add(-time.Minute))
	mustExec(t, pool, `UPDATE workflow_runs SET status = 'cancelled', completed_at = NOW() WHERE id = $1`, fixture.runID)

	backlog, err := q.GetClaimableWorkflowTaskBacklog(context.Background())
	require.NoError(t, err)
	assert.Zero(t, backlog.Depth)

	runnerID := mustCreateRunner(t, pool, "terminal-parent-runner")
	_, err = q.ClaimPendingTask(context.Background(), runnerParam(runnerID))
	require.ErrorIs(t, err, pgx.ErrNoRows)

	var status string
	err = pool.QueryRow(context.Background(), `SELECT status FROM workflow_tasks WHERE id = $1`, task.ID).Scan(&status)
	require.NoError(t, err)
	assert.Equal(t, "pending", status)
}

func TestRequeueTasksForRunner_RequeuesAssignedAndRunningTasks(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-requeue")

	now := time.Now().UTC()
	requeueStartedAt := time.Now().UTC()
	runnerID := mustCreateRunner(t, pool, "requeue-runner")
	otherRunnerID := mustCreateRunner(t, pool, "requeue-other-runner")

	assignedTask := mustCreateWorkflowTask(t, q, fixture, "pending")
	runningTask := mustCreateWorkflowTask(t, q, fixture, "pending")
	pendingTask := mustCreateWorkflowTask(t, q, fixture, "pending")
	doneTask := mustCreateWorkflowTask(t, q, fixture, "pending")
	otherRunnerTask := mustCreateWorkflowTask(t, q, fixture, "pending")

	mustSetWorkflowTaskAssignment(t, pool, assignedTask.ID, "assigned", runnerID, now.Add(-3*time.Minute), pgtype.Timestamptz{})
	mustSetWorkflowTaskAssignment(t, pool, runningTask.ID, "running", runnerID, now.Add(-4*time.Minute), pgtype.Timestamptz{Time: now.Add(-2 * time.Minute), Valid: true})
	mustSetWorkflowTaskAssignment(t, pool, doneTask.ID, "done", runnerID, now.Add(-5*time.Minute), pgtype.Timestamptz{Time: now.Add(-4 * time.Minute), Valid: true})
	mustSetWorkflowTaskAssignment(t, pool, otherRunnerTask.ID, "assigned", otherRunnerID, now.Add(-6*time.Minute), pgtype.Timestamptz{})

	requeued, err := q.RequeueTasksForRunner(context.Background(), runnerParam(runnerID))
	require.NoError(t, err)
	assert.Equal(t, int64(2), requeued)

	assertWorkflowTaskAssignmentState(t, pool, assignedTask.ID, "pending", false, false, false)
	assertWorkflowTaskAssignmentState(t, pool, runningTask.ID, "pending", false, false, false)
	assertWorkflowTaskAssignmentState(t, pool, pendingTask.ID, "pending", false, false, false)
	assertWorkflowTaskAssignmentState(t, pool, doneTask.ID, "done", true, true, true)
	assertWorkflowTaskAssignmentState(t, pool, otherRunnerTask.ID, "assigned", true, true, false)
	assertWorkflowTaskAvailableAfter(t, pool, assignedTask.ID, requeueStartedAt)
	assertWorkflowTaskAvailableAfter(t, pool, runningTask.ID, requeueStartedAt)
}

func TestRequeueTasksForRunner_AppliesExponentialBackoffFromAttempt(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-requeue-backoff")

	runnerID := mustCreateRunner(t, pool, "requeue-backoff-runner")
	task := mustCreateWorkflowTask(t, q, fixture, "pending")
	now := time.Now().UTC()

	mustSetWorkflowTaskAssignment(t, pool, task.ID, "running", runnerID, now.Add(-3*time.Minute), pgtype.Timestamptz{
		Time:  now.Add(-2 * time.Minute),
		Valid: true,
	})
	mustSetWorkflowTaskAttempt(t, pool, task.ID, 3)

	requeueStartedAt := time.Now().UTC()
	requeued, err := q.RequeueTasksForRunner(context.Background(), runnerParam(runnerID))
	require.NoError(t, err)
	assert.Equal(t, int64(1), requeued)

	availableAt := workflowTaskAvailableAt(t, pool, task.ID)
	delay := availableAt.Sub(requeueStartedAt)
	assert.GreaterOrEqual(t, delay, 4*time.Second-time.Second)
	assert.Less(t, delay, 5*time.Minute+time.Second)
}

func TestRequeueTasksForRunner_CapsBackoffAtFiveMinutes(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-requeue-cap")

	runnerID := mustCreateRunner(t, pool, "requeue-cap-runner")
	task := mustCreateWorkflowTask(t, q, fixture, "pending")
	now := time.Now().UTC()

	mustSetWorkflowTaskAssignment(t, pool, task.ID, "running", runnerID, now.Add(-3*time.Minute), pgtype.Timestamptz{
		Time:  now.Add(-2 * time.Minute),
		Valid: true,
	})
	mustSetWorkflowTaskAttempt(t, pool, task.ID, 12)

	requeueStartedAt := time.Now().UTC()
	requeued, err := q.RequeueTasksForRunner(context.Background(), runnerParam(runnerID))
	require.NoError(t, err)
	assert.Equal(t, int64(1), requeued)

	availableAt := workflowTaskAvailableAt(t, pool, task.ID)
	delay := availableAt.Sub(requeueStartedAt)
	assert.GreaterOrEqual(t, delay, 5*time.Minute-time.Second)
	assert.LessOrEqual(t, delay, 5*time.Minute+time.Second)
}

func TestRequeueTasksForRunner_QueuesRunningWorkflowStep(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-requeue-step")

	runnerID := mustCreateRunner(t, pool, "requeue-step-runner")
	task := mustCreateWorkflowTask(t, q, fixture, "pending")
	now := time.Now().UTC()

	mustSetWorkflowTaskAssignment(t, pool, task.ID, "running", runnerID, now.Add(-3*time.Minute), pgtype.Timestamptz{
		Time:  now.Add(-2 * time.Minute),
		Valid: true,
	})
	rows, err := q.UpdateWorkflowStepStatusRunning(context.Background(), fixture.stepID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)

	requeued, err := q.RequeueTasksForRunner(context.Background(), runnerParam(runnerID))
	require.NoError(t, err)
	assert.Equal(t, int64(1), requeued)

	assertWorkflowStepState(t, pool, fixture.stepID, "queued", false, false)
}

func TestCancelWorkflowRunAndTasks_CancelsOnlyNonTerminalStates(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-cancel")

	runnerID := mustCreateRunner(t, pool, "workflow-cancel-runner")
	now := time.Now().UTC()

	pendingTask := mustCreateWorkflowTask(t, q, fixture, "pending")
	assignedTask := mustCreateWorkflowTask(t, q, fixture, "pending")
	runningTask := mustCreateWorkflowTask(t, q, fixture, "pending")
	doneTask := mustCreateWorkflowTask(t, q, fixture, "done")
	failedTask := mustCreateWorkflowTask(t, q, fixture, "failed")
	cancelledTask := mustCreateWorkflowTask(t, q, fixture, "cancelled")

	mustSetWorkflowTaskAssignment(t, pool, assignedTask.ID, "assigned", runnerID, now.Add(-2*time.Minute), pgtype.Timestamptz{})
	mustSetWorkflowTaskAssignment(t, pool, runningTask.ID, "running", runnerID, now.Add(-3*time.Minute), pgtype.Timestamptz{
		Time:  now.Add(-2 * time.Minute),
		Valid: true,
	})

	err := q.CancelWorkflowRun(context.Background(), fixture.runID)
	require.NoError(t, err)
	err = q.CancelWorkflowTasks(context.Background(), fixture.runID)
	require.NoError(t, err)

	run, err := q.GetWorkflowRun(context.Background(), GetWorkflowRunParams{
		ID:           fixture.runID,
		RepositoryID: fixture.repoID,
	})
	require.NoError(t, err)
	assert.Equal(t, "cancelled", run.Status)
	assert.True(t, run.CompletedAt.Valid, "run should be marked completed")

	assertWorkflowTaskStatus(t, pool, pendingTask.ID, "cancelled")
	assertWorkflowTaskStatus(t, pool, assignedTask.ID, "cancelled")
	assertWorkflowTaskStatus(t, pool, runningTask.ID, "cancelled")
	assertWorkflowTaskStatus(t, pool, doneTask.ID, "done")
	assertWorkflowTaskStatus(t, pool, failedTask.ID, "failed")
	assertWorkflowTaskStatus(t, pool, cancelledTask.ID, "cancelled")
}

func TestWorkflowTaskTransitions_ValidPath(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-transition-valid")

	task := mustCreateWorkflowTask(t, q, fixture, "pending")
	runnerID := mustCreateRunner(t, pool, "transition-valid-runner")

	_, err := q.ClaimPendingTask(context.Background(), runnerParam(runnerID))
	require.NoError(t, err)

	runningRows, err := q.MarkWorkflowTaskRunning(context.Background(), MarkWorkflowTaskRunningParams{
		ID:       task.ID,
		RunnerID: runnerParam(runnerID),
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), runningRows)

	workflowRunID, err := q.MarkWorkflowTaskDone(context.Background(), MarkWorkflowTaskDoneParams{
		ID:        task.ID,
		RunnerID:  runnerParam(runnerID),
		Status:    "done",
		LastError: pgtype.Text{},
	})
	require.NoError(t, err)
	assert.Greater(t, workflowRunID, int64(0), "should return the workflow_run_id on success")

	var status string
	var assignedRunnerID pgtype.Int8
	var startedAt pgtype.Timestamptz
	var finishedAt pgtype.Timestamptz
	err = pool.QueryRow(
		context.Background(),
		`SELECT status, runner_id, started_at, finished_at
		 FROM workflow_tasks
		 WHERE id = $1`,
		task.ID,
	).Scan(&status, &assignedRunnerID, &startedAt, &finishedAt)
	require.NoError(t, err)

	assert.Equal(t, "done", status)
	assert.True(t, assignedRunnerID.Valid)
	assert.Equal(t, runnerID, assignedRunnerID.Int64)
	assert.True(t, startedAt.Valid)
	assert.True(t, finishedAt.Valid)
}

func TestWorkflowTaskTransitions_InvalidPathRejected(t *testing.T) {
	t.Run("pending_to_running", func(t *testing.T) {
		q, pool := newQueries(t)
		fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-transition-invalid-pending-running")
		task := mustCreateWorkflowTask(t, q, fixture, "pending")
		runnerID := mustCreateRunner(t, pool, "transition-invalid-pr-runner")

		rows, err := q.MarkWorkflowTaskRunning(context.Background(), MarkWorkflowTaskRunningParams{
			ID:       task.ID,
			RunnerID: runnerParam(runnerID),
		})
		require.NoError(t, err)
		assert.Equal(t, int64(0), rows)
		assertWorkflowTaskStatus(t, pool, task.ID, "pending")
	})

	t.Run("assigned_to_done", func(t *testing.T) {
		q, pool := newQueries(t)
		fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-transition-invalid-assigned-done")
		task := mustCreateWorkflowTask(t, q, fixture, "pending")
		runnerID := mustCreateRunner(t, pool, "transition-invalid-ad-runner")

		_, err := q.ClaimPendingTask(context.Background(), runnerParam(runnerID))
		require.NoError(t, err)

		// Task is in 'assigned' state (not 'running'), so MarkWorkflowTaskDone returns ErrNoRows.
		_, err = q.MarkWorkflowTaskDone(context.Background(), MarkWorkflowTaskDoneParams{
			ID:        task.ID,
			RunnerID:  runnerParam(runnerID),
			Status:    "done",
			LastError: pgtype.Text{},
		})
		require.ErrorIs(t, err, pgx.ErrNoRows)
		assertWorkflowTaskStatus(t, pool, task.ID, "assigned")
	})

	t.Run("done_to_running", func(t *testing.T) {
		q, pool := newQueries(t)
		fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-transition-invalid-done-running")
		task := mustCreateWorkflowTask(t, q, fixture, "pending")
		runnerID := mustCreateRunner(t, pool, "transition-invalid-dr-runner")

		_, err := q.ClaimPendingTask(context.Background(), runnerParam(runnerID))
		require.NoError(t, err)

		startRows, err := q.MarkWorkflowTaskRunning(context.Background(), MarkWorkflowTaskRunningParams{
			ID:       task.ID,
			RunnerID: runnerParam(runnerID),
		})
		require.NoError(t, err)
		assert.Equal(t, int64(1), startRows)

		finishRunID, err := q.MarkWorkflowTaskDone(context.Background(), MarkWorkflowTaskDoneParams{
			ID:        task.ID,
			RunnerID:  runnerParam(runnerID),
			Status:    "done",
			LastError: pgtype.Text{},
		})
		require.NoError(t, err)
		assert.Greater(t, finishRunID, int64(0), "should return workflow_run_id on success")

		rows, err := q.MarkWorkflowTaskRunning(context.Background(), MarkWorkflowTaskRunningParams{
			ID:       task.ID,
			RunnerID: runnerParam(runnerID),
		})
		require.NoError(t, err)
		assert.Equal(t, int64(0), rows)
		assertWorkflowTaskStatus(t, pool, task.ID, "done")
	})

	t.Run("running_to_done_wrong_runner", func(t *testing.T) {
		q, pool := newQueries(t)
		fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-transition-invalid-running-done-wrong-runner")
		task := mustCreateWorkflowTask(t, q, fixture, "pending")
		runnerID := mustCreateRunner(t, pool, "transition-invalid-rd-correct-runner")
		otherRunnerID := mustCreateRunner(t, pool, "transition-invalid-rd-wrong-runner")

		_, err := q.ClaimPendingTask(context.Background(), runnerParam(runnerID))
		require.NoError(t, err)

		runningRows, err := q.MarkWorkflowTaskRunning(context.Background(), MarkWorkflowTaskRunningParams{
			ID:       task.ID,
			RunnerID: runnerParam(runnerID),
		})
		require.NoError(t, err)
		assert.Equal(t, int64(1), runningRows)

		// Wrong runner: MarkWorkflowTaskDone returns ErrNoRows since runner_id doesn't match.
		_, err = q.MarkWorkflowTaskDone(context.Background(), MarkWorkflowTaskDoneParams{
			ID:        task.ID,
			RunnerID:  runnerParam(otherRunnerID),
			Status:    "done",
			LastError: pgtype.Text{},
		})
		require.ErrorIs(t, err, pgx.ErrNoRows)
		assertWorkflowTaskStatus(t, pool, task.ID, "running")
	})
}

func TestWorkflowListAndTaskStateQueries(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "workflow-list-user")
	repoID := mustCreateRepo(t, pool, userID, "workflow-list-repo")
	cfg := []byte(`{"triggers":[{"type":"push"}],"steps":[{"name":"build","run":"make build"}]}`)

	def1, err := q.CreateWorkflowDefinition(context.Background(), CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "CI One",
		Path:         ".smithers/workflows/ci-one.tsx",
		Config:       cfg,
	})
	require.NoError(t, err)

	def2, err := q.CreateWorkflowDefinition(context.Background(), CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "CI Two",
		Path:         ".smithers/workflows/ci-two.tsx",
		Config:       cfg,
	})
	require.NoError(t, err)

	defPage, err := q.ListWorkflowDefinitionsByRepo(context.Background(), ListWorkflowDefinitionsByRepoParams{
		RepositoryID: repoID,
		PageOffset:   0,
		PageSize:     1,
	})
	require.NoError(t, err)
	require.Len(t, defPage, 1)
	assert.Equal(t, def2.ID, defPage[0].ID)

	run1, err := q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def1.ID,
		Status:               "queued",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "sha-1",
	})
	require.NoError(t, err)

	run2, err := q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def2.ID,
		Status:               "queued",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "sha-2",
	})
	require.NoError(t, err)

	runPage, err := q.ListWorkflowRunsByRepo(context.Background(), ListWorkflowRunsByRepoParams{
		RepositoryID: repoID,
		PageOffset:   0,
		PageSize:     1,
	})
	require.NoError(t, err)
	require.Len(t, runPage, 1)
	assert.Equal(t, run2.ID, runPage[0].ID)

	step, err := q.CreateWorkflowStep(context.Background(), CreateWorkflowStepParams{
		WorkflowRunID: run1.ID,
		Name:          "build",
		Position:      1,
		Status:        "queued",
	})
	require.NoError(t, err)

	task, err := q.CreateWorkflowTask(context.Background(), CreateWorkflowTaskParams{
		WorkflowRunID:  run1.ID,
		WorkflowStepID: step.ID,
		RepositoryID:   repoID,
		Status:         "pending",
		Priority:       2,
		Payload:        []byte(`{"kind":"step"}`),
		AvailableAt:    time.Now().UTC().Add(-1 * time.Second),
	})
	require.NoError(t, err)
	assert.Equal(t, int16(2), task.Priority)

	runnerID := mustCreateRunner(t, pool, "workflow-list-runner")
	claimed, err := q.ClaimPendingTask(context.Background(), runnerParam(runnerID))
	require.NoError(t, err)
	assert.Equal(t, task.ID, claimed.ID)

	runningRows, err := q.MarkWorkflowTaskRunning(context.Background(), MarkWorkflowTaskRunningParams{
		ID:       task.ID,
		RunnerID: runnerParam(runnerID),
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), runningRows)

	doneRunID, err := q.MarkWorkflowTaskDone(context.Background(), MarkWorkflowTaskDoneParams{
		ID:        task.ID,
		RunnerID:  runnerParam(runnerID),
		Status:    "done",
		LastError: pgtype.Text{},
	})
	require.NoError(t, err)
	assert.Greater(t, doneRunID, int64(0), "should return the workflow_run_id on success")

	var status string
	var assignedRunnerID pgtype.Int8
	err = pool.QueryRow(context.Background(), `SELECT status, runner_id FROM workflow_tasks WHERE id = $1`, task.ID).Scan(&status, &assignedRunnerID)
	require.NoError(t, err)
	assert.Equal(t, "done", status)
	assert.True(t, assignedRunnerID.Valid)
	assert.Equal(t, runnerID, assignedRunnerID.Int64)

	commitStatus, err := q.CreateCommitStatus(context.Background(), CreateCommitStatusParams{
		RepositoryID: repoID,
		ChangeID: pgtype.Text{
			String: "kxyz123",
			Valid:  true,
		},
		CommitSha: pgtype.Text{
			String: "abc123",
			Valid:  true,
		},
		Context:       "ci/build",
		Status:        "success",
		Description:   "all green",
		TargetUrl:     "https://example.com/run/1",
		WorkflowRunID: pgtype.Int8{Int64: run1.ID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, repoID, commitStatus.RepositoryID)
}

type workflowTaskFixture struct {
	repoID int64
	runID  int64
	stepID int64
}

func mustCreateWorkflowTaskFixture(t *testing.T, q *Queries, pool DBTX, prefix string, executionPlanes ...string) workflowTaskFixture {
	t.Helper()
	executionPlane := ""
	if len(executionPlanes) > 0 {
		executionPlane = executionPlanes[0]
	}

	userID := mustCreateUser(t, pool, prefix+"-user")
	repoID := mustCreateRepo(t, pool, userID, prefix+"-repo")

	cfg := []byte(`{"triggers":[{"type":"push"}],"steps":[{"name":"test","run":"make test"}]}`)
	def, err := q.CreateWorkflowDefinition(context.Background(), CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Workflow",
		Path:         ".smithers/workflows/test.tsx",
		Config:       cfg,
	})
	require.NoError(t, err)

	run, err := q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "queued",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "sha-task-fixture",
		ExecutionPlane:       executionPlane,
	})
	require.NoError(t, err)

	step, err := q.CreateWorkflowStep(context.Background(), CreateWorkflowStepParams{
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

func mustCreateWorkflowTask(t *testing.T, q *Queries, fixture workflowTaskFixture, status string) WorkflowTask {
	t.Helper()

	task, err := q.CreateWorkflowTask(context.Background(), CreateWorkflowTaskParams{
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

func mustSetTaskPriorityAndCreatedAt(t *testing.T, pool DBTX, taskID int64, priority int16, createdAt time.Time) {
	t.Helper()

	_, err := pool.Exec(
		context.Background(),
		`UPDATE workflow_tasks
		 SET priority = $2, created_at = $3, updated_at = $3
		 WHERE id = $1`,
		taskID,
		priority,
		createdAt,
	)
	require.NoError(t, err)
}

func mustSetWorkflowTaskState(t *testing.T, pool DBTX, taskID int64, status string, availableAt time.Time) {
	t.Helper()

	_, err := pool.Exec(
		context.Background(),
		`UPDATE workflow_tasks
		 SET status = $2,
		     available_at = $3,
		     updated_at = NOW()
		 WHERE id = $1`,
		taskID,
		status,
		availableAt,
	)
	require.NoError(t, err)
}

func mustSetWorkflowTaskAssignment(
	t *testing.T,
	pool DBTX,
	taskID int64,
	status string,
	runnerID int64,
	assignedAt time.Time,
	startedAt pgtype.Timestamptz,
) {
	t.Helper()

	_, err := pool.Exec(
		context.Background(),
		`UPDATE workflow_tasks
		 SET status = $2,
		     runner_id = $3,
		     assigned_at = $4,
		     started_at = $5,
		     updated_at = NOW()
		 WHERE id = $1`,
		taskID,
		status,
		runnerID,
		assignedAt,
		startedAt,
	)
	require.NoError(t, err)
}

func mustSetWorkflowTaskAttempt(t *testing.T, pool DBTX, taskID int64, attempt int32) {
	t.Helper()

	_, err := pool.Exec(
		context.Background(),
		`UPDATE workflow_tasks
		 SET attempt = $2,
		     updated_at = NOW()
		 WHERE id = $1`,
		taskID,
		attempt,
	)
	require.NoError(t, err)
}

func mustCreateRunner(t *testing.T, pool DBTX, name string) int64 {
	t.Helper()

	var runnerID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO runner_pool (name, status, metadata)
		 VALUES ($1, 'idle', '{}'::jsonb)
		 RETURNING id`,
		name,
	).Scan(&runnerID)
	require.NoError(t, err)
	return runnerID
}

func assertWorkflowTaskStatus(t *testing.T, pool DBTX, taskID int64, wantStatus string) {
	t.Helper()

	var status string
	err := pool.QueryRow(context.Background(), `SELECT status FROM workflow_tasks WHERE id = $1`, taskID).Scan(&status)
	require.NoError(t, err)
	assert.Equal(t, wantStatus, status)
}

func assertWorkflowTaskAssignmentState(
	t *testing.T,
	pool DBTX,
	taskID int64,
	wantStatus string,
	wantRunner bool,
	wantAssignedAt bool,
	wantStartedAt bool,
) {
	t.Helper()

	var status string
	var runnerID pgtype.Int8
	var assignedAt pgtype.Timestamptz
	var startedAt pgtype.Timestamptz
	err := pool.QueryRow(
		context.Background(),
		`SELECT status, runner_id, assigned_at, started_at
		 FROM workflow_tasks
		 WHERE id = $1`,
		taskID,
	).Scan(&status, &runnerID, &assignedAt, &startedAt)
	require.NoError(t, err)

	assert.Equal(t, wantStatus, status)
	assert.Equal(t, wantRunner, runnerID.Valid)
	assert.Equal(t, wantAssignedAt, assignedAt.Valid)
	assert.Equal(t, wantStartedAt, startedAt.Valid)
}

func workflowTaskAvailableAt(t *testing.T, pool DBTX, taskID int64) time.Time {
	t.Helper()

	var availableAt time.Time
	err := pool.QueryRow(context.Background(), `SELECT available_at FROM workflow_tasks WHERE id = $1`, taskID).Scan(&availableAt)
	require.NoError(t, err)
	return availableAt
}

func assertWorkflowTaskAvailableAfter(t *testing.T, pool DBTX, taskID int64, after time.Time) {
	t.Helper()

	availableAt := workflowTaskAvailableAt(t, pool, taskID)
	assert.True(t, availableAt.After(after), "task %d should be delayed until after %s, got %s", taskID, after, availableAt)
}

func assertWorkflowStepState(
	t *testing.T,
	pool DBTX,
	stepID int64,
	wantStatus string,
	wantStartedAt bool,
	wantCompletedAt bool,
) {
	t.Helper()

	var status string
	var startedAt pgtype.Timestamptz
	var completedAt pgtype.Timestamptz
	err := pool.QueryRow(
		context.Background(),
		`SELECT status, started_at, completed_at
		 FROM workflow_steps
		 WHERE id = $1`,
		stepID,
	).Scan(&status, &startedAt, &completedAt)
	require.NoError(t, err)

	assert.Equal(t, wantStatus, status)
	assert.Equal(t, wantStartedAt, startedAt.Valid)
	assert.Equal(t, wantCompletedAt, completedAt.Valid)
}

func runnerParam(runnerID int64) pgtype.Int8 {
	return pgtype.Int8{Int64: runnerID, Valid: true}
}
