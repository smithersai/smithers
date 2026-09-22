package deploymentdb

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Regression tests for the dual-executor race: the sandbox whole-workflow
// scheduler (ClaimQueuedWorkflowRuns) and the gVisor task runner
// (ClaimPendingTask) must never both be able to claim work for the same
// workflow run. workflow_runs.execution_plane is the authoritative
// discriminator: 'runner' runs are claimable only task-wise, 'sandbox' runs
// only run-wise, and 'agent' runs by neither.

type executionPlaneFixture struct {
	repoID int64
	runID  int64
	stepID int64
	taskID int64
}

// mustCreateExecutionPlaneFixture commits a definition + queued run (with the
// given execution plane) + step + pending task through sharedPool, so the
// FOR UPDATE SKIP LOCKED claim queries can see the rows from any connection.
func mustCreateExecutionPlaneFixture(t *testing.T, prefix, plane string) executionPlaneFixture {
	t.Helper()

	q := New(sharedPool)
	userID := mustCreateUser(t, sharedPool, prefix+"-user")
	repoID := mustCreateRepo(t, sharedPool, userID, prefix+"-repo")

	def, err := q.CreateWorkflowDefinition(context.Background(), CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Plane",
		Path:         ".smithers/workflows/" + prefix + ".tsx",
		Config:       []byte(`{"on":{"push":{}},"jobs":{"test":{}}}`),
	})
	require.NoError(t, err)

	run, err := q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "queued",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "sha-" + prefix,
		ExecutionPlane:       plane,
	})
	require.NoError(t, err)

	step, err := q.CreateWorkflowStep(context.Background(), CreateWorkflowStepParams{
		WorkflowRunID: run.ID,
		Name:          "test",
		Position:      1,
		Status:        "queued",
	})
	require.NoError(t, err)

	task := mustCreateWorkflowTask(t, q, workflowTaskFixture{repoID: repoID, runID: run.ID, stepID: step.ID}, "pending")

	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_tasks WHERE workflow_run_id = $1`, run.ID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_steps WHERE workflow_run_id = $1`, run.ID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_runs WHERE id = $1`, run.ID)
	})

	return executionPlaneFixture{repoID: repoID, runID: run.ID, stepID: step.ID, taskID: task.ID}
}

// drainClaimQueuedRuns claims sandbox-plane runs until the queue is empty and
// returns how often each run ID was claimed.
func drainClaimQueuedRuns(t *testing.T, q *Queries) map[int64]int {
	t.Helper()
	counts := map[int64]int{}
	for {
		runs, err := q.ClaimQueuedWorkflowRuns(context.Background(), 100)
		require.NoError(t, err)
		if len(runs) == 0 {
			return counts
		}
		for _, run := range runs {
			counts[run.ID]++
		}
	}
}

// drainClaimPendingTasks claims runner-plane tasks until the queue is empty
// and returns, per claimed task ID, the run it belongs to.
func drainClaimPendingTasks(t *testing.T, q *Queries, runnerID int64) map[int64]int64 {
	t.Helper()
	claimed := map[int64]int64{}
	for {
		task, err := q.ClaimPendingTask(context.Background(), runnerParam(runnerID))
		if errors.Is(err, pgx.ErrNoRows) {
			return claimed
		}
		require.NoError(t, err)
		claimed[task.ID] = task.WorkflowRunID
	}
}

func TestCreateWorkflowRun_ExecutionPlaneDefaultsAndPersists(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "plane-default-user")
	repoID := mustCreateRepo(t, pool, userID, "plane-default-repo")
	def, err := q.CreateWorkflowDefinition(context.Background(), CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Plane",
		Path:         ".smithers/workflows/plane-default.tsx",
		Config:       []byte(`{"on":{"push":{}},"jobs":{"test":{}}}`),
	})
	require.NoError(t, err)

	makeRun := func(plane string) WorkflowRun {
		run, err := q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
			RepositoryID:         repoID,
			WorkflowDefinitionID: def.ID,
			Status:               "queued",
			TriggerEvent:         "push",
			TriggerRef:           "main",
			TriggerCommitSha:     "sha-plane-" + plane,
			ExecutionPlane:       plane,
		})
		require.NoError(t, err)
		return run
	}

	// Legacy callers that pass no plane must land deterministically on the
	// runner plane — the safe default the sandbox scheduler never claims.
	assert.Equal(t, "runner", makeRun("").ExecutionPlane)
	assert.Equal(t, "sandbox", makeRun("sandbox").ExecutionPlane)
	assert.Equal(t, "agent", makeRun("agent").ExecutionPlane)

	// The CHECK constraint rejects unknown planes.
	_, err = q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "queued",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "sha-plane-bogus",
		ExecutionPlane:       "bogus",
	})
	require.Error(t, err)
}

func TestExecutionPlane_ClaimsAreMutuallyExclusive(t *testing.T) {
	seq := testSeqCounter.Add(1)
	q := New(sharedPool)

	runnerFix := mustCreateExecutionPlaneFixture(t, fmt.Sprintf("plane-excl-runner-%d", seq), "runner")
	sandboxFix := mustCreateExecutionPlaneFixture(t, fmt.Sprintf("plane-excl-sandbox-%d", seq), "sandbox")
	agentFix := mustCreateExecutionPlaneFixture(t, fmt.Sprintf("plane-excl-agent-%d", seq), "agent")

	// The sandbox scheduler's claim sees only the sandbox-plane run.
	claimedRuns := drainClaimQueuedRuns(t, q)
	assert.Equal(t, 1, claimedRuns[sandboxFix.runID], "sandbox-plane run must be claimable by the sandbox scheduler")
	assert.Zero(t, claimedRuns[runnerFix.runID], "runner-plane (standard CI) run must never be claimed by the sandbox scheduler")
	assert.Zero(t, claimedRuns[agentFix.runID], "agent-plane run must never be claimed by the sandbox scheduler")

	// The gVisor runner's claim sees only the runner-plane task — including
	// the sandbox run's task, which is still status='pending' after the run
	// itself was claimed above.
	runnerID := mustCreateRunner(t, sharedPool, fmt.Sprintf("plane-excl-runner-pool-%d", seq))
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM runner_pool WHERE id = $1`, runnerID)
	})
	claimedTasks := drainClaimPendingTasks(t, q, runnerID)
	_, runnerTaskClaimed := claimedTasks[runnerFix.taskID]
	assert.True(t, runnerTaskClaimed, "runner-plane task must be claimable by the task runner")
	assert.NotContains(t, claimedTasks, sandboxFix.taskID, "sandbox-plane task must never be claimed by the task runner")
	assert.NotContains(t, claimedTasks, agentFix.taskID, "agent-plane task must never be claimed by the task runner")
}

// TestExecutionPlane_ConcurrentClaims_OnlyOwningPlaneWins is the direct
// dual-executor regression: with both planes claiming concurrently (the gVisor
// runner "fixed" and racing the sandbox scheduler), each run is executed by
// exactly one plane, exactly once.
func TestExecutionPlane_ConcurrentClaims_OnlyOwningPlaneWins(t *testing.T) {
	seq := testSeqCounter.Add(1)
	q := New(sharedPool)

	runnerFix := mustCreateExecutionPlaneFixture(t, fmt.Sprintf("plane-race-runner-%d", seq), "runner")
	sandboxFix := mustCreateExecutionPlaneFixture(t, fmt.Sprintf("plane-race-sandbox-%d", seq), "sandbox")

	const workers = 6
	runnerIDs := make([]int64, workers)
	for i := range runnerIDs {
		runnerIDs[i] = mustCreateRunner(t, sharedPool, fmt.Sprintf("plane-race-runner-pool-%d-%d", seq, i))
	}
	t.Cleanup(func() {
		for _, id := range runnerIDs {
			_, _ = sharedPool.Exec(context.Background(), `DELETE FROM runner_pool WHERE id = $1`, id)
		}
	})

	var (
		mu         sync.Mutex
		taskClaims = map[int64]int{} // task ID -> claim count
		taskRuns   = map[int64]int{} // run ID  -> tasks claimed for it
		runClaims  = map[int64]int{} // run ID  -> whole-run claim count
		claimErrs  []error
		wg         sync.WaitGroup
	)

	for i := 0; i < workers; i++ {
		wg.Add(2)
		go func(runnerID int64) {
			defer wg.Done()
			for {
				task, err := q.ClaimPendingTask(context.Background(), runnerParam(runnerID))
				if errors.Is(err, pgx.ErrNoRows) {
					return
				}
				mu.Lock()
				if err != nil {
					claimErrs = append(claimErrs, err)
					mu.Unlock()
					return
				}
				taskClaims[task.ID]++
				taskRuns[task.WorkflowRunID]++
				mu.Unlock()
			}
		}(runnerIDs[i])
		go func() {
			defer wg.Done()
			for {
				runs, err := q.ClaimQueuedWorkflowRuns(context.Background(), 10)
				mu.Lock()
				if err != nil {
					claimErrs = append(claimErrs, err)
					mu.Unlock()
					return
				}
				if len(runs) == 0 {
					mu.Unlock()
					return
				}
				for _, run := range runs {
					runClaims[run.ID]++
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	require.Empty(t, claimErrs, "claim queries must not error under concurrency")

	assert.Equal(t, 1, taskClaims[runnerFix.taskID], "runner-plane task must be claimed exactly once")
	assert.Zero(t, taskClaims[sandboxFix.taskID], "sandbox-plane task must never be claimed by the task runner")
	assert.Equal(t, 1, runClaims[sandboxFix.runID], "sandbox-plane run must be claimed exactly once")
	assert.Zero(t, runClaims[runnerFix.runID], "runner-plane run must never be claimed by the sandbox scheduler")

	// The core invariant: no run may be executed by both planes.
	for runID := range runClaims {
		assert.Zero(t, taskRuns[runID],
			"run %d was claimed whole by the sandbox scheduler AND task-wise by the runner", runID)
	}
}

// TestExecutionPlane_ResumedRunnerRunStaysOffSandboxPlane covers the
// retry/recovery path: cancelling and resuming a runner-plane run re-queues
// the run and its tasks, and the re-queued work must still be claimable only
// by the task runner.
func TestExecutionPlane_ResumedRunnerRunStaysOffSandboxPlane(t *testing.T) {
	seq := testSeqCounter.Add(1)
	q := New(sharedPool)

	fix := mustCreateExecutionPlaneFixture(t, fmt.Sprintf("plane-resume-%d", seq), "runner")

	require.NoError(t, q.CancelWorkflowRun(context.Background(), fix.runID))
	require.NoError(t, q.CancelWorkflowTasks(context.Background(), fix.runID))
	require.NoError(t, q.ResumeWorkflowRun(context.Background(), fix.runID))
	require.NoError(t, q.ResumeWorkflowTasks(context.Background(), fix.runID))

	claimedRuns := drainClaimQueuedRuns(t, q)
	assert.Zero(t, claimedRuns[fix.runID], "resumed runner-plane run must not become claimable by the sandbox scheduler")

	runnerID := mustCreateRunner(t, sharedPool, fmt.Sprintf("plane-resume-runner-pool-%d", seq))
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM runner_pool WHERE id = $1`, runnerID)
	})
	claimedTasks := drainClaimPendingTasks(t, q, runnerID)
	_, resumedClaimed := claimedTasks[fix.taskID]
	assert.True(t, resumedClaimed, "resumed runner-plane task must still be claimable by the task runner")
}

func TestExecutionPlane_LegacyRunClaimIsFencedDuringRollingUpgrade(t *testing.T) {
	seq := testSeqCounter.Add(1)
	ctx := context.Background()
	q := New(sharedPool)

	runnerFix := mustCreateExecutionPlaneFixture(t, fmt.Sprintf("plane-legacy-runner-%d", seq), "runner")
	sandboxFix := mustCreateExecutionPlaneFixture(t, fmt.Sprintf("plane-legacy-sandbox-%d", seq), "sandbox")
	agentFix := mustCreateExecutionPlaneFixture(t, fmt.Sprintf("plane-legacy-agent-%d", seq), "agent")

	// Simulate the previous release's unfiltered whole-workflow claim. The
	// BEFORE trigger must silently suppress runner/agent rows so its multi-row
	// UPDATE can still return the one legitimate sandbox claim.
	tag, err := sharedPool.Exec(ctx, `
		UPDATE workflow_runs
		SET status = 'running', started_at = NOW(), updated_at = NOW()
		WHERE id = ANY($1::bigint[]) AND status = 'queued'
	`, []int64{runnerFix.runID, sandboxFix.runID, agentFix.runID})
	require.NoError(t, err)
	assert.Equal(t, int64(1), tag.RowsAffected())

	runnerRun, err := q.GetWorkflowRunByRunID(ctx, runnerFix.runID)
	require.NoError(t, err)
	sandboxRun, err := q.GetWorkflowRunByRunID(ctx, sandboxFix.runID)
	require.NoError(t, err)
	agentRun, err := q.GetWorkflowRunByRunID(ctx, agentFix.runID)
	require.NoError(t, err)
	assert.Equal(t, "queued", runnerRun.Status)
	assert.Equal(t, "running", sandboxRun.Status)
	assert.Equal(t, "queued", agentRun.Status)

	// The new aggregate query sets a transaction-local marker for one exact run.
	// Prove that marker cannot bleed into a legacy update for a different run on
	// the same connection, then let the marked agent transition proceed.
	tx, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(context.Background()) }()
	txQ := q.WithTx(tx)

	status, err := txQ.UpdateWorkflowRunStatusBasedOnTasks(ctx, runnerFix.runID)
	require.NoError(t, err)
	assert.Equal(t, "running", status)
	tag, err = tx.Exec(ctx, `UPDATE workflow_runs SET status = 'running' WHERE id = $1`, agentFix.runID)
	require.NoError(t, err)
	assert.Zero(t, tag.RowsAffected(), "runner run marker must not authorize an agent run")
	status, err = txQ.UpdateWorkflowRunStatusBasedOnTasks(ctx, agentFix.runID)
	require.NoError(t, err)
	assert.Equal(t, "running", status)
	require.NoError(t, tx.Commit(ctx))
}

func TestExecutionPlane_LegacyTaskClaimsAndPreassignedTasksAreFenced(t *testing.T) {
	seq := testSeqCounter.Add(1)
	ctx := context.Background()
	q := New(sharedPool)

	runnerFix := mustCreateExecutionPlaneFixture(t, fmt.Sprintf("plane-legacy-task-runner-%d", seq), "runner")
	sandboxFix := mustCreateExecutionPlaneFixture(t, fmt.Sprintf("plane-legacy-task-sandbox-%d", seq), "sandbox")
	agentFix := mustCreateExecutionPlaneFixture(t, fmt.Sprintf("plane-legacy-task-agent-%d", seq), "agent")
	runnerID := mustCreateRunner(t, sharedPool, fmt.Sprintf("plane-legacy-task-pool-%d", seq))
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM runner_pool WHERE id = $1`, runnerID)
	})

	// Simulate the previous release's task claim, which did not join the parent
	// run. Only the runner-plane task may become assigned.
	tag, err := sharedPool.Exec(ctx, `
		UPDATE workflow_tasks
		SET status = 'assigned', runner_id = $1, assigned_at = NOW()
		WHERE id = ANY($2::bigint[]) AND status = 'pending'
	`, runnerID, []int64{runnerFix.taskID, sandboxFix.taskID, agentFix.taskID})
	require.NoError(t, err)
	assert.Equal(t, int64(1), tag.RowsAffected())

	runnerTask, err := q.GetWorkflowTask(ctx, GetWorkflowTaskParams{ID: runnerFix.taskID, RepositoryID: runnerFix.repoID})
	require.NoError(t, err)
	sandboxTask, err := q.GetWorkflowTask(ctx, GetWorkflowTaskParams{ID: sandboxFix.taskID, RepositoryID: sandboxFix.repoID})
	require.NoError(t, err)
	agentTask, err := q.GetWorkflowTask(ctx, GetWorkflowTaskParams{ID: agentFix.taskID, RepositoryID: agentFix.repoID})
	require.NoError(t, err)
	assert.Equal(t, "assigned", runnerTask.Status)
	assert.Equal(t, "pending", sandboxTask.Status)
	assert.Equal(t, "pending", agentTask.Status)

	// Rows assigned immediately before the migration already carry runner
	// ownership. Insert that pre-migration shape directly, then verify only the
	// runner-plane row can advance to running after the fence is installed.
	createPreassigned := func(fix executionPlaneFixture, label string) WorkflowTask {
		task := mustCreateWorkflowTask(t, q, workflowTaskFixture{
			repoID: fix.repoID,
			runID:  fix.runID,
			stepID: fix.stepID,
		}, "assigned")
		mustExec(t, sharedPool,
			`UPDATE workflow_tasks SET runner_id = $1, assigned_at = NOW(), payload = $2::jsonb WHERE id = $3`,
			runnerID, fmt.Sprintf(`{"kind":%q}`, label), task.ID)
		return task
	}
	preRunner := createPreassigned(runnerFix, "runner")
	preSandbox := createPreassigned(sandboxFix, "sandbox")
	preAgent := createPreassigned(agentFix, "agent")

	tag, err = sharedPool.Exec(ctx, `
		UPDATE workflow_tasks
		SET status = 'running', started_at = NOW()
		WHERE id = ANY($1::bigint[]) AND status = 'assigned'
	`, []int64{preRunner.ID, preSandbox.ID, preAgent.ID})
	require.NoError(t, err)
	assert.Equal(t, int64(1), tag.RowsAffected())

	for _, tc := range []struct {
		taskID int64
		repoID int64
		want   string
	}{
		{taskID: preRunner.ID, repoID: runnerFix.repoID, want: "running"},
		{taskID: preSandbox.ID, repoID: sandboxFix.repoID, want: "assigned"},
		{taskID: preAgent.ID, repoID: agentFix.repoID, want: "assigned"},
	} {
		got, getErr := q.GetWorkflowTask(ctx, GetWorkflowTaskParams{ID: tc.taskID, RepositoryID: tc.repoID})
		require.NoError(t, getErr)
		assert.Equal(t, tc.want, got.Status)
	}

	// Agent VM dispatch remains valid for an assigned task that has no runner
	// ownership: it supplies a VM ID instead.
	agentVMTask := mustCreateWorkflowTask(t, q, workflowTaskFixture{
		repoID: agentFix.repoID,
		runID:  agentFix.runID,
		stepID: agentFix.stepID,
	}, "assigned")
	affected, err := q.MarkWorkflowTaskVMRunning(ctx, MarkWorkflowTaskVMRunningParams{
		ID:   agentVMTask.ID,
		VmID: pgtype.Text{String: "agent-vm", Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), affected)
}

func TestExecutionPlane_AgentInsertDefaultAndRunPlaneImmutability(t *testing.T) {
	seq := testSeqCounter.Add(1)
	ctx := context.Background()
	q := New(sharedPool)
	userID := mustCreateUser(t, sharedPool, fmt.Sprintf("plane-agent-default-user-%d", seq))
	repoID := mustCreateRepo(t, sharedPool, userID, fmt.Sprintf("plane-agent-default-repo-%d", seq))
	agentDef, err := q.UpsertAgentWorkflowDefinition(ctx, repoID)
	require.NoError(t, err)

	// This is the old writer shape: execution_plane is omitted and would have
	// taken the runner default without the insert trigger.
	var runID int64
	var plane string
	err = sharedPool.QueryRow(ctx, `
		INSERT INTO workflow_runs (
			repository_id, workflow_definition_id, status, trigger_event,
			trigger_ref, trigger_commit_sha
		) VALUES ($1, $2, 'queued', 'agent_message', '', '')
		RETURNING id, execution_plane
	`, repoID, agentDef.ID).Scan(&runID, &plane)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_runs WHERE id = $1`, runID)
	})
	assert.Equal(t, "agent", plane)

	_, err = sharedPool.Exec(ctx,
		`UPDATE workflow_runs SET execution_plane = 'runner' WHERE id = $1`, runID)
	require.Error(t, err, "execution plane must be immutable after insert")

	got, err := q.GetWorkflowRunByRunID(ctx, runID)
	require.NoError(t, err)
	assert.Equal(t, "agent", got.ExecutionPlane)
}
