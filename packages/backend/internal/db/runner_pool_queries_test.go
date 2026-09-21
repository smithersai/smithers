package db

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUpsertRunner_ByName_UpdatesHeartbeatAndMetadata(t *testing.T) {
	q, pool := newQueries(t)

	firstMeta := json.RawMessage(`{"zone":"a"}`)
	first, err := q.UpsertRunner(context.Background(), UpsertRunnerParams{
		Name:     "runner-upsert",
		Metadata: firstMeta,
	})
	require.NoError(t, err)
	require.True(t, first.LastHeartbeatAt.Valid)
	assert.Equal(t, "idle", first.Status)
	assert.JSONEq(t, string(firstMeta), string(first.Metadata))

	mustSetRunnerHeartbeatAndStatus(t, pool, first.ID, "idle", time.Now().UTC().Add(-2*time.Minute))

	secondMeta := json.RawMessage(`{"zone":"b","labels":{"cpu":"x64"}}`)
	second, err := q.UpsertRunner(context.Background(), UpsertRunnerParams{
		Name:     "runner-upsert",
		Metadata: secondMeta,
	})
	require.NoError(t, err)

	assert.Equal(t, first.ID, second.ID)
	assert.Equal(t, "idle", second.Status)
	assert.JSONEq(t, string(secondMeta), string(second.Metadata))
	require.True(t, second.LastHeartbeatAt.Valid)
	assert.WithinDuration(t, time.Now().UTC(), second.LastHeartbeatAt.Time, 5*time.Second)
}

func TestUpsertRunner_ByName_PreservesBusyStatusOnReregister(t *testing.T) {
	q, pool := newQueries(t)

	first, err := q.UpsertRunner(context.Background(), UpsertRunnerParams{
		Name:     "runner-upsert-busy",
		Metadata: json.RawMessage(`{"zone":"a"}`),
	})
	require.NoError(t, err)
	assert.Equal(t, "idle", first.Status)

	mustSetRunnerHeartbeatAndStatus(t, pool, first.ID, "busy", time.Now().UTC().Add(-2*time.Minute))

	second, err := q.UpsertRunner(context.Background(), UpsertRunnerParams{
		Name:     "runner-upsert-busy",
		Metadata: json.RawMessage(`{"zone":"b"}`),
	})
	require.NoError(t, err)
	assert.Equal(t, first.ID, second.ID)
	assert.Equal(t, "busy", second.Status)
}

func TestTouchRunnerHeartbeat_UpdatesLastHeartbeatAt(t *testing.T) {
	q, pool := newQueries(t)

	runnerID := mustCreateRunner(t, pool, "runner-touch")
	oldHeartbeat := time.Now().UTC().Add(-5 * time.Minute)
	mustSetRunnerHeartbeatAndStatus(t, pool, runnerID, "idle", oldHeartbeat)

	touched, err := q.TouchRunnerHeartbeat(context.Background(), runnerID)
	require.NoError(t, err)
	require.True(t, touched.LastHeartbeatAt.Valid)
	assert.WithinDuration(t, time.Now().UTC(), touched.LastHeartbeatAt.Time, 5*time.Second)
	assert.True(t, touched.LastHeartbeatAt.Time.After(oldHeartbeat))

	var dbHeartbeat time.Time
	err = pool.QueryRow(context.Background(), `SELECT last_heartbeat_at FROM runner_pool WHERE id = $1`, runnerID).Scan(&dbHeartbeat)
	require.NoError(t, err)
	assert.WithinDuration(t, touched.LastHeartbeatAt.Time, dbHeartbeat, time.Second)
}

func TestClaimIdleRunner_TransitionsIdleToBusy(t *testing.T) {
	q, pool := newQueries(t)

	idleRunnerID := mustCreateRunner(t, pool, "runner-claim-idle")
	claimed, err := q.ClaimIdleRunner(context.Background(), idleRunnerID)
	require.NoError(t, err)
	assert.Equal(t, idleRunnerID, claimed.ID)
	assert.Equal(t, "busy", claimed.Status)

	_, err = q.ClaimIdleRunner(context.Background(), idleRunnerID)
	require.ErrorIs(t, err, pgx.ErrNoRows)

	offlineRunnerID := mustInsertRunnerWithStatus(t, pool, "runner-claim-offline", "offline")
	_, err = q.ClaimIdleRunner(context.Background(), offlineRunnerID)
	require.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestReleaseRunner_TransitionsBusyToIdle(t *testing.T) {
	q, pool := newQueries(t)

	runnerID := mustCreateRunner(t, pool, "runner-release")
	_, err := q.ClaimIdleRunner(context.Background(), runnerID)
	require.NoError(t, err)

	released, err := q.ReleaseRunner(context.Background(), runnerID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), released)

	// Second release should return 0 rows affected (no error)
	released2, err := q.ReleaseRunner(context.Background(), runnerID)
	require.NoError(t, err)
	assert.Equal(t, int64(0), released2)
}

func TestReleaseRunner_RefusesRunnerWithAssignedOrRunningTask(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "runner-release-active")
	task := mustCreateWorkflowTask(t, q, fixture, "pending")
	runnerID := mustCreateRunner(t, pool, "runner-release-active")

	_, err := q.ClaimIdleRunner(ctx, runnerID)
	require.NoError(t, err)
	claimed, err := q.ClaimPendingTask(ctx, runnerParam(runnerID))
	require.NoError(t, err)
	assert.Equal(t, task.ID, claimed.ID)

	released, err := q.ReleaseRunner(ctx, runnerID)
	require.NoError(t, err)
	assert.Zero(t, released, "assigned task ownership must keep the runner busy")

	affected, err := q.MarkWorkflowTaskRunning(ctx, MarkWorkflowTaskRunningParams{
		ID:       task.ID,
		RunnerID: runnerParam(runnerID),
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), affected)
	released, err = q.ReleaseRunner(ctx, runnerID)
	require.NoError(t, err)
	assert.Zero(t, released, "running task ownership must keep the runner busy")

	_, err = q.MarkWorkflowTaskDone(ctx, MarkWorkflowTaskDoneParams{
		ID:       task.ID,
		RunnerID: runnerParam(runnerID),
		Status:   "done",
	})
	require.NoError(t, err)
	cleared, err := q.ClearTerminalWorkflowTaskRunnerOwnership(ctx, ClearTerminalWorkflowTaskRunnerOwnershipParams{
		TaskID:   task.ID,
		RunnerID: runnerParam(runnerID + 1),
	})
	require.NoError(t, err)
	assert.Zero(t, cleared, "a different runner must not clear terminal ownership")
	cleared, err = q.ClearTerminalWorkflowTaskRunnerOwnership(ctx, ClearTerminalWorkflowTaskRunnerOwnershipParams{
		TaskID:   task.ID,
		RunnerID: runnerParam(runnerID),
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), cleared)
	cleared, err = q.ClearTerminalWorkflowTaskRunnerOwnership(ctx, ClearTerminalWorkflowTaskRunnerOwnershipParams{
		TaskID:   task.ID,
		RunnerID: runnerParam(runnerID),
	})
	require.NoError(t, err)
	assert.Zero(t, cleared, "terminal ownership clear must be replay-safe")
	released, err = q.ReleaseRunner(ctx, runnerID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), released, "terminal task no longer blocks runner release")
}

func TestTerminateRunner_TransitionsToOffline(t *testing.T) {
	q, pool := newQueries(t)

	idleRunnerID := mustCreateRunner(t, pool, "runner-terminate-idle")
	terminatedIdle, err := q.TerminateRunner(context.Background(), idleRunnerID)
	require.NoError(t, err)
	assert.Equal(t, "offline", terminatedIdle.Status)

	_, err = q.TerminateRunner(context.Background(), idleRunnerID)
	require.ErrorIs(t, err, pgx.ErrNoRows)

	busyRunnerID := mustCreateRunner(t, pool, "runner-terminate-busy")
	_, err = q.ClaimIdleRunner(context.Background(), busyRunnerID)
	require.NoError(t, err)

	terminatedBusy, err := q.TerminateRunner(context.Background(), busyRunnerID)
	require.NoError(t, err)
	assert.Equal(t, "offline", terminatedBusy.Status)
}

func TestListStaleRunners_BeforeCutoffOnly(t *testing.T) {
	q, pool := newQueries(t)

	cutoff := time.Now().UTC().Add(-1 * time.Minute)

	staleIdleID := mustCreateRunner(t, pool, "runner-stale-idle")
	mustSetRunnerHeartbeatAndStatus(t, pool, staleIdleID, "idle", cutoff.Add(-10*time.Second))

	staleBusyID := mustCreateRunner(t, pool, "runner-stale-busy")
	mustSetRunnerHeartbeatAndStatus(t, pool, staleBusyID, "busy", cutoff.Add(-30*time.Second))

	freshBusyID := mustCreateRunner(t, pool, "runner-fresh-busy")
	mustSetRunnerHeartbeatAndStatus(t, pool, freshBusyID, "busy", cutoff.Add(10*time.Second))

	offlineID := mustCreateRunner(t, pool, "runner-offline")
	mustSetRunnerHeartbeatAndStatus(t, pool, offlineID, "offline", cutoff.Add(-10*time.Second))

	stale, err := q.ListStaleRunners(context.Background(), pgtype.Timestamptz{
		Time:  cutoff,
		Valid: true,
	})
	require.NoError(t, err)

	gotIDs := make([]int64, 0, len(stale))
	for _, r := range stale {
		gotIDs = append(gotIDs, r.ID)
		assert.Contains(t, []string{"idle", "busy", "draining"}, r.Status)
	}

	assert.Equal(t, []int64{staleIdleID, staleBusyID}, gotIDs)
}

func mustInsertRunnerWithStatus(t *testing.T, pool DBTX, name, status string) int64 {
	t.Helper()

	var runnerID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO runner_pool (name, status, metadata, last_heartbeat_at)
		 VALUES ($1, $2, '{}'::jsonb, NOW())
		 RETURNING id`,
		name,
		status,
	).Scan(&runnerID)
	require.NoError(t, err)
	return runnerID
}

func mustSetRunnerHeartbeatAndStatus(t *testing.T, pool DBTX, runnerID int64, status string, heartbeat time.Time) {
	t.Helper()

	_, err := pool.Exec(
		context.Background(),
		`UPDATE runner_pool
		 SET status = $2, last_heartbeat_at = $3, updated_at = NOW()
		 WHERE id = $1`,
		runnerID,
		status,
		heartbeat,
	)
	require.NoError(t, err)
}
