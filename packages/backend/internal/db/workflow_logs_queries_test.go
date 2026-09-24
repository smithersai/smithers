package db

import (
	"context"
	"fmt"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInsertWorkflowLog_ReturnsCreatedLog(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-log-insert")

	created, err := q.InsertWorkflowLog(context.Background(), InsertWorkflowLogParams{
		WorkflowRunID:  fixture.runID,
		WorkflowStepID: fixture.stepID,
		Sequence:       1,
		Stream:         "stdout",
		Entry:          "hello from runner",
	})
	require.NoError(t, err)

	assert.Equal(t, fixture.runID, created.WorkflowRunID)
	assert.Equal(t, fixture.stepID, created.WorkflowStepID)
	assert.Equal(t, int64(1), created.Sequence)
	assert.Equal(t, "stdout", created.Stream)
	assert.Equal(t, "hello from runner", created.Entry)
}

func TestInsertWorkflowLog_EnforcesUniqueSequencePerStep(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-log-unique")

	_, err := q.InsertWorkflowLog(context.Background(), InsertWorkflowLogParams{
		WorkflowRunID:  fixture.runID,
		WorkflowStepID: fixture.stepID,
		Sequence:       7,
		Stream:         "stdout",
		Entry:          "first",
	})
	require.NoError(t, err)

	_, err = q.InsertWorkflowLog(context.Background(), InsertWorkflowLogParams{
		WorkflowRunID:  fixture.runID,
		WorkflowStepID: fixture.stepID,
		Sequence:       7,
		Stream:         "stderr",
		Entry:          "duplicate sequence",
	})
	require.Error(t, err)
}

func TestInsertWorkflowLog_AllowsSameSequenceForDifferentSteps(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-log-same-seq-different-step")

	secondStep, err := q.CreateWorkflowStep(context.Background(), CreateWorkflowStepParams{
		WorkflowRunID: fixture.runID,
		Name:          "deploy",
		Position:      2,
		Status:        "queued",
	})
	require.NoError(t, err)

	firstLog, err := q.InsertWorkflowLog(context.Background(), InsertWorkflowLogParams{
		WorkflowRunID:  fixture.runID,
		WorkflowStepID: fixture.stepID,
		Sequence:       4,
		Stream:         "stdout",
		Entry:          "step one",
	})
	require.NoError(t, err)

	secondLog, err := q.InsertWorkflowLog(context.Background(), InsertWorkflowLogParams{
		WorkflowRunID:  fixture.runID,
		WorkflowStepID: secondStep.ID,
		Sequence:       4,
		Stream:         "stdout",
		Entry:          "step two",
	})
	require.NoError(t, err)

	assert.Equal(t, int64(4), firstLog.Sequence)
	assert.Equal(t, int64(4), secondLog.Sequence)
	assert.NotEqual(t, firstLog.WorkflowStepID, secondLog.WorkflowStepID)
}

func TestGetWorkflowTaskForRunner_ReturnsRunningTask(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-log-get-running")

	task := mustCreateWorkflowTask(t, q, fixture, "running")
	_, err := pool.Exec(context.Background(), `UPDATE workflow_tasks SET attempt = 3 WHERE id = $1`, task.ID)
	require.NoError(t, err)
	got, err := q.GetWorkflowTaskForRunner(context.Background(), task.ID)
	require.NoError(t, err)

	assert.Equal(t, task.ID, got.ID)
	assert.Equal(t, fixture.runID, got.WorkflowRunID)
	assert.Equal(t, fixture.stepID, got.WorkflowStepID)
	assert.Equal(t, "running", got.Status)
	assert.Equal(t, int32(3), got.Attempt)
}

func TestGetWorkflowTaskForRunner_RejectsNonRunningTask(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "workflow-log-get-not-running")

	task := mustCreateWorkflowTask(t, q, fixture, "pending")
	_, err := q.GetWorkflowTaskForRunner(context.Background(), task.ID)
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestNotifyWorkflowLog_Executes(t *testing.T) {
	// NOTIFY only delivers after COMMIT, so this test uses sharedPool directly
	// instead of the per-test transaction.
	seq := testSeqCounter.Add(1)
	poolQ := New(sharedPool)
	fixture := mustCreateWorkflowTaskFixture(t, poolQ, sharedPool, fmt.Sprintf("workflow-log-notify-%d", seq))
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_logs WHERE workflow_step_id = $1`, fixture.stepID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_tasks WHERE step_id = $1`, fixture.stepID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_steps WHERE run_id = $1`, fixture.runID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workflow_runs WHERE id = $1`, fixture.runID)
	})

	channel := "workflow_step_logs_" + int64ToString(fixture.stepID)
	payload := `{"id":123,"entry":"hello"}`

	listenerConn, err := sharedPool.Acquire(context.Background())
	require.NoError(t, err)
	defer listenerConn.Release()

	_, err = listenerConn.Exec(context.Background(), "LISTEN "+channel)
	require.NoError(t, err)

	err = poolQ.NotifyWorkflowLog(context.Background(), NotifyWorkflowLogParams{
		StepID:  fixture.stepID,
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

func int64ToString(v int64) string {
	return strconv.FormatInt(v, 10)
}
