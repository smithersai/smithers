package db

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

func TestRunnersQueries_ClaimAvailableRunner(t *testing.T) {
	// FOR UPDATE SKIP LOCKED requires separate database connections (not savepoints
	// within the same transaction), so this test uses sharedPool directly.
	seq := testSeqCounter.Add(1)
	poolQ := New(sharedPool)

	idleStaleID := mustCreateRunnerForRunnersQueries(t, sharedPool, fmt.Sprintf("runner-claim-stale-%d", seq))
	mustSetRunnerHeartbeatAndStatusForRunnersQueries(t, sharedPool, idleStaleID, "idle", time.Now().UTC().Add(-5*time.Minute))

	idleLockID := mustCreateRunnerForRunnersQueries(t, sharedPool, fmt.Sprintf("runner-claim-lock-%d", seq))
	mustSetRunnerHeartbeatAndStatusForRunnersQueries(t, sharedPool, idleLockID, "idle", time.Now().UTC().Add(-10*time.Second))

	idleClaimID := mustCreateRunnerForRunnersQueries(t, sharedPool, fmt.Sprintf("runner-claim-next-%d", seq))
	mustSetRunnerHeartbeatAndStatusForRunnersQueries(t, sharedPool, idleClaimID, "idle", time.Now().UTC().Add(-8*time.Second))

	busyID := mustCreateRunnerForRunnersQueries(t, sharedPool, fmt.Sprintf("runner-claim-busy-%d", seq))
	mustSetRunnerHeartbeatAndStatusForRunnersQueries(t, sharedPool, busyID, "busy", time.Now().UTC().Add(-5*time.Second))

	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM runner_pool WHERE id IN ($1, $2, $3, $4)`,
			idleStaleID, idleLockID, idleClaimID, busyID)
	})

	// Lock the idleLockID runner from a separate connection to simulate contention.
	tx, err := sharedPool.Begin(context.Background())
	require.NoError(t, err)
	defer tx.Rollback(context.Background())

	var lockedID int64
	err = tx.QueryRow(context.Background(), `SELECT id FROM runner_pool WHERE id = $1 FOR UPDATE`, idleLockID).Scan(&lockedID)
	require.NoError(t, err)
	assert.Equal(t, idleLockID, lockedID)

	// ClaimAvailableRunner uses FOR UPDATE SKIP LOCKED, so it should skip the locked runner.
	claimed, err := poolQ.ClaimAvailableRunner(context.Background(), pgtype.Interval{Microseconds: 30 * 1000000, Valid: true})
	require.NoError(t, err)
	assert.Equal(t, idleClaimID, claimed.ID)
	assert.Equal(t, "busy", claimed.Status)

	// Release the lock so the second claim can proceed.
	require.NoError(t, tx.Rollback(context.Background()))

	// idleLockID is now unlocked but it's idle. Claim it next.
	claimed2, err := poolQ.ClaimAvailableRunner(context.Background(), pgtype.Interval{Microseconds: 30 * 1000000, Valid: true})
	require.NoError(t, err)
	assert.Equal(t, idleLockID, claimed2.ID)

	// No more idle runners with recent heartbeat — should get ErrNoRows.
	_, err = poolQ.ClaimAvailableRunner(context.Background(), pgtype.Interval{Microseconds: 30 * 1000000, Valid: true})
	require.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestRunnersQueries_ReleaseRunner(t *testing.T) {
	q, pool := newQueries(t)

	runnerID := mustCreateRunnerForRunnersQueries(t, pool, "runner-release")
	mustSetRunnerHeartbeatAndStatusForRunnersQueries(t, pool, runnerID, "busy", time.Now().UTC())

	rows, err := q.ReleaseRunner(context.Background(), runnerID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)

	var status string
	err = pool.QueryRow(context.Background(), `SELECT status FROM runner_pool WHERE id = $1`, runnerID).Scan(&status)
	require.NoError(t, err)
	assert.Equal(t, "idle", status)

	rows, err = q.ReleaseRunner(context.Background(), runnerID)
	require.NoError(t, err)
	assert.Equal(t, int64(0), rows)
}

func TestRunnersQueries_ListRunners(t *testing.T) {
	q, pool := newQueries(t)

	idleOld := mustCreateRunnerForRunnersQueries(t, pool, "runner-list-idle-old")
	idleNew := mustCreateRunnerForRunnersQueries(t, pool, "runner-list-idle-new")
	busyID := mustCreateRunnerForRunnersQueries(t, pool, "runner-list-busy")
	offlineID := mustCreateRunnerForRunnersQueries(t, pool, "runner-list-offline")

	mustSetRunnerHeartbeatAndStatusForRunnersQueries(t, pool, idleOld, "idle", time.Now().UTC().Add(-50*time.Second))
	mustSetRunnerHeartbeatAndStatusForRunnersQueries(t, pool, idleNew, "idle", time.Now().UTC().Add(-40*time.Second))
	mustSetRunnerHeartbeatAndStatusForRunnersQueries(t, pool, busyID, "busy", time.Now().UTC().Add(-30*time.Second))
	mustSetRunnerHeartbeatAndStatusForRunnersQueries(t, pool, offlineID, "offline", time.Now().UTC().Add(-20*time.Second))

	all, err := q.ListRunners(context.Background(), ListRunnersParams{
		StatusFilter: "",
		PageOffset:   0,
		PageSize:     10,
	})
	require.NoError(t, err)
	require.Len(t, all, 4)
	assert.Equal(t, []int64{offlineID, busyID, idleNew, idleOld}, []int64{all[0].ID, all[1].ID, all[2].ID, all[3].ID})

	idleOnly, err := q.ListRunners(context.Background(), ListRunnersParams{
		StatusFilter: "idle",
		PageOffset:   0,
		PageSize:     10,
	})
	require.NoError(t, err)
	require.Len(t, idleOnly, 2)
	assert.Equal(t, []int64{idleNew, idleOld}, []int64{idleOnly[0].ID, idleOnly[1].ID})

	paged, err := q.ListRunners(context.Background(), ListRunnersParams{
		StatusFilter: "",
		PageOffset:   1,
		PageSize:     2,
	})
	require.NoError(t, err)
	require.Len(t, paged, 2)
	assert.Equal(t, []int64{busyID, idleNew}, []int64{paged[0].ID, paged[1].ID})
}

func TestRunnersQueries_CleanupStaleRunners(t *testing.T) {
	q, pool := newQueries(t)

	staleIdleID := mustCreateRunnerForRunnersQueries(t, pool, "runner-cleanup-stale-idle")
	mustSetRunnerHeartbeatAndStatusForRunnersQueries(t, pool, staleIdleID, "idle", time.Now().UTC().Add(-2*time.Minute))

	staleBusyID := mustCreateRunnerForRunnersQueries(t, pool, "runner-cleanup-stale-busy")
	mustSetRunnerHeartbeatAndStatusForRunnersQueries(t, pool, staleBusyID, "busy", time.Now().UTC().Add(-2*time.Minute))

	freshIdleID := mustCreateRunnerForRunnersQueries(t, pool, "runner-cleanup-fresh-idle")
	mustSetRunnerHeartbeatAndStatusForRunnersQueries(t, pool, freshIdleID, "idle", time.Now().UTC().Add(-10*time.Second))

	offlineID := mustCreateRunnerForRunnersQueries(t, pool, "runner-cleanup-offline")
	mustSetRunnerHeartbeatAndStatusForRunnersQueries(t, pool, offlineID, "offline", time.Now().UTC().Add(-2*time.Minute))

	rows, err := q.CleanupStaleRunners(context.Background(), pgtype.Interval{Microseconds: 60 * 1000000, Valid: true})
	require.NoError(t, err)
	assert.Equal(t, int64(2), rows)

	assertRunnerStatus(t, pool, staleIdleID, "offline")
	assertRunnerStatus(t, pool, staleBusyID, "offline")
	assertRunnerStatus(t, pool, freshIdleID, "idle")
	assertRunnerStatus(t, pool, offlineID, "offline")
}

func assertRunnerStatus(t *testing.T, pool DBTX, runnerID int64, want string) {
	t.Helper()

	var status string
	err := pool.QueryRow(context.Background(), `SELECT status FROM runner_pool WHERE id = $1`, runnerID).Scan(&status)
	require.NoError(t, err)
	assert.Equal(t, want, status)
}

func mustCreateRunnerForRunnersQueries(t *testing.T, pool DBTX, name string) int64 {
	t.Helper()

	var runnerID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO runner_pool (name, status, metadata, last_heartbeat_at)
		 VALUES ($1, 'idle', '{}'::jsonb, NOW())
		 RETURNING id`,
		name,
	).Scan(&runnerID)
	require.NoError(t, err)
	return runnerID
}

func mustSetRunnerHeartbeatAndStatusForRunnersQueries(t *testing.T, pool DBTX, runnerID int64, status string, heartbeat time.Time) {
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
