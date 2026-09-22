package deploymentdb

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClaimRunnerWorkflowTask_ConcurrentRunnersClaimTaskOnce(t *testing.T) {
	seq := testSeqCounter.Add(1)
	ctx := context.Background()
	q := New(sharedPool)
	fixture := mustCreateWorkflowTaskFixture(t, q, sharedPool, fmt.Sprintf("atomic-runner-claim-%d", seq))
	task := mustCreateWorkflowTask(t, q, fixture, "pending")
	mustSetTaskPriorityAndCreatedAt(t, sharedPool, task.ID, 3, time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC))

	runnerIDs := []int64{
		mustCreateRunner(t, sharedPool, fmt.Sprintf("atomic-runner-claim-a-%d", seq)),
		mustCreateRunner(t, sharedPool, fmt.Sprintf("atomic-runner-claim-b-%d", seq)),
	}
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_runs WHERE id = $1`, fixture.runID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM runner_pool WHERE id = ANY($1::bigint[])`, runnerIDs)
	})

	// Keep unrelated pending fixtures out of this global production queue so
	// the race proves both runners contend for this exact task.
	blockers, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	defer blockers.Rollback(ctx)
	rows, err := blockers.Query(ctx, `
		SELECT id
		FROM workflow_tasks
		WHERE status = 'pending' AND id <> $1
		FOR UPDATE
	`, task.ID)
	require.NoError(t, err)
	for rows.Next() {
		var ignored int64
		require.NoError(t, rows.Scan(&ignored))
	}
	require.NoError(t, rows.Err())
	rows.Close()

	type claimResult struct {
		runnerID int64
		task     ClaimRunnerWorkflowTaskRow
		err      error
	}
	start := make(chan struct{})
	results := make(chan claimResult, len(runnerIDs))
	for _, runnerID := range runnerIDs {
		runnerID := runnerID
		go func() {
			<-start
			claimed, claimErr := New(sharedPool).ClaimRunnerWorkflowTask(ctx, runnerID)
			results <- claimResult{runnerID: runnerID, task: claimed, err: claimErr}
		}()
	}
	close(start)

	var winnerID int64
	for range runnerIDs {
		result := <-results
		if result.err == nil {
			require.Zero(t, winnerID, "only one runner may claim the task")
			winnerID = result.runnerID
			assert.Equal(t, task.ID, result.task.ID)
			assert.Equal(t, "running", result.task.Status)
			assert.Equal(t, int32(1), result.task.Attempt)
			assert.True(t, result.task.RunnerID.Valid)
			assert.Equal(t, result.runnerID, result.task.RunnerID.Int64)
			assert.True(t, result.task.AssignedAt.Valid)
			assert.True(t, result.task.StartedAt.Valid)
			continue
		}
		require.ErrorIs(t, result.err, pgx.ErrNoRows)
	}
	require.NotZero(t, winnerID)

	var taskStatus string
	var taskRunnerID pgtype.Int8
	var attempt int32
	var assignedAt, taskStartedAt pgtype.Timestamptz
	err = sharedPool.QueryRow(ctx, `
		SELECT status, runner_id, attempt, assigned_at, started_at
		FROM workflow_tasks
		WHERE id = $1
	`, task.ID).Scan(&taskStatus, &taskRunnerID, &attempt, &assignedAt, &taskStartedAt)
	require.NoError(t, err)
	assert.Equal(t, "running", taskStatus)
	assert.Equal(t, winnerID, taskRunnerID.Int64)
	assert.Equal(t, int32(1), attempt)
	assert.True(t, assignedAt.Valid)
	assert.True(t, taskStartedAt.Valid)

	var stepStatus string
	var stepStartedAt pgtype.Timestamptz
	err = sharedPool.QueryRow(ctx, `SELECT status, started_at FROM workflow_steps WHERE id = $1`, fixture.stepID).Scan(&stepStatus, &stepStartedAt)
	require.NoError(t, err)
	assert.Equal(t, "running", stepStatus)
	assert.True(t, stepStartedAt.Valid)

	for _, runnerID := range runnerIDs {
		var status string
		require.NoError(t, sharedPool.QueryRow(ctx, `SELECT status FROM runner_pool WHERE id = $1`, runnerID).Scan(&status))
		if runnerID == winnerID {
			assert.Equal(t, "busy", status)
		} else {
			assert.Equal(t, "idle", status)
		}
	}
}

func TestClaimRunnerWorkflowTask_StepFailureRollsBackTaskAndRunner(t *testing.T) {
	q, tx := newQueries(t)
	ctx := context.Background()
	seq := testSeqCounter.Add(1)
	fixture := mustCreateWorkflowTaskFixture(t, q, tx, fmt.Sprintf("atomic-runner-rollback-%d", seq))
	task := mustCreateWorkflowTask(t, q, fixture, "pending")
	runnerID := mustCreateRunner(t, tx, fmt.Sprintf("atomic-runner-rollback-%d", seq))

	functionName := fmt.Sprintf("test_fail_atomic_runner_step_%d", seq)
	triggerName := fmt.Sprintf("test_fail_atomic_runner_step_%d", seq)
	mustExec(t, tx, fmt.Sprintf(`
		CREATE FUNCTION %s()
		RETURNS trigger AS $body$
		BEGIN
			IF NEW.status = 'running' THEN
				RAISE EXCEPTION 'injected atomic runner step failure';
			END IF;
			RETURN NEW;
		END;
		$body$ LANGUAGE plpgsql;
		CREATE TRIGGER %s
		BEFORE UPDATE OF status ON workflow_steps
		FOR EACH ROW
		EXECUTE FUNCTION %s();
	`, functionName, triggerName, functionName))

	claimErr := mustExpectQueryError(t, tx, func(spQ *Queries) error {
		_, err := spQ.ClaimRunnerWorkflowTask(ctx, runnerID)
		return err
	})
	assert.Contains(t, claimErr.Error(), "injected atomic runner step failure")

	var taskStatus string
	var taskRunnerID pgtype.Int8
	var attempt int32
	var assignedAt, taskStartedAt pgtype.Timestamptz
	err := tx.QueryRow(ctx, `
		SELECT status, runner_id, attempt, assigned_at, started_at
		FROM workflow_tasks
		WHERE id = $1
	`, task.ID).Scan(&taskStatus, &taskRunnerID, &attempt, &assignedAt, &taskStartedAt)
	require.NoError(t, err)
	assert.Equal(t, "pending", taskStatus)
	assert.False(t, taskRunnerID.Valid)
	assert.Zero(t, attempt)
	assert.False(t, assignedAt.Valid)
	assert.False(t, taskStartedAt.Valid)

	var stepStatus string
	var stepStartedAt pgtype.Timestamptz
	err = tx.QueryRow(ctx, `SELECT status, started_at FROM workflow_steps WHERE id = $1`, fixture.stepID).Scan(&stepStatus, &stepStartedAt)
	require.NoError(t, err)
	assert.Equal(t, "queued", stepStatus)
	assert.False(t, stepStartedAt.Valid)

	var runnerStatus string
	err = tx.QueryRow(ctx, `SELECT status FROM runner_pool WHERE id = $1`, runnerID).Scan(&runnerStatus)
	require.NoError(t, err)
	assert.Equal(t, "idle", runnerStatus)
}
