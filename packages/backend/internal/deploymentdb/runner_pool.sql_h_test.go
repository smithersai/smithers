package deploymentdb

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type runnerPoolSQLHDB = chunk5SQLHDB
type runnerPoolSQLHRow = chunk5SQLHRow
type runnerPoolSQLHRows = chunk5SQLHRows

func TestRunnerPoolSQL_H_CountListCleanupAndRelease(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	cutoff := time.Now().UTC().Add(-time.Minute)

	idleOld := runnerPoolSQLHCreateRunner(t, q, pool, "idle", cutoff.Add(-time.Minute))
	busyOld := runnerPoolSQLHCreateRunner(t, q, pool, "busy", cutoff.Add(-time.Minute))
	drainingOld := runnerPoolSQLHCreateRunner(t, q, pool, "draining", cutoff.Add(-time.Minute))
	releaseBusy := runnerPoolSQLHCreateRunner(t, q, pool, "busy", time.Now().UTC())

	allCount, err := q.CountRunners(ctx, "")
	require.NoError(t, err)
	assert.Equal(t, int64(4), allCount)
	busyCount, err := q.CountRunners(ctx, "busy")
	require.NoError(t, err)
	assert.Equal(t, int64(2), busyCount)
	all, err := q.ListRunners(ctx, ListRunnersParams{StatusFilter: "", PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, all, 4)
	busy, err := q.ListRunners(ctx, ListRunnersParams{StatusFilter: "busy", PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, busy, 2)
	empty, err := q.ListRunners(ctx, ListRunnersParams{StatusFilter: "missing", PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	assert.Empty(t, empty)

	stale, err := q.ListStaleRunners(ctx, pgtype.Timestamptz{Time: cutoff, Valid: true})
	require.NoError(t, err)
	assert.True(t, runnerPoolSQLHHasRunner(stale, idleOld))
	assert.True(t, runnerPoolSQLHHasRunner(stale, busyOld))
	assert.True(t, runnerPoolSQLHHasRunner(stale, drainingOld))

	released, err := q.ReleaseRunner(ctx, releaseBusy)
	require.NoError(t, err)
	assert.Equal(t, int64(1), released)
	released, err = q.ReleaseRunner(ctx, releaseBusy)
	require.NoError(t, err)
	assert.Zero(t, released)

	cleaned, err := q.CleanupStaleRunners(ctx, pgtype.Interval{Microseconds: int64(60 * 1000000), Valid: true})
	require.NoError(t, err)
	assert.Equal(t, int64(2), cleaned)
	offlineCount, err := q.CountRunners(ctx, "offline")
	require.NoError(t, err)
	assert.Equal(t, int64(2), offlineCount)
}

func TestRunnerPoolSQL_H_ErrorBranches(t *testing.T) {
	sentinel := errors.New("runner pool h failed")
	for _, call := range []func(*Queries) error{
		func(q *Queries) error {
			_, err := q.ListRunners(context.Background(), ListRunnersParams{PageSize: 1})
			return err
		},
		func(q *Queries) error {
			_, err := q.ListStaleRunners(context.Background(), pgtype.Timestamptz{})
			return err
		},
	} {
		require.ErrorIs(t, call(New(runnerPoolSQLHDB{queryErr: sentinel})), sentinel)
		require.ErrorIs(t, call(New(runnerPoolSQLHDB{rows: &runnerPoolSQLHRows{next: true, scanErr: sentinel}})), sentinel)
		require.ErrorIs(t, call(New(runnerPoolSQLHDB{rows: &runnerPoolSQLHRows{err: sentinel}})), sentinel)
	}
	_, err := New(runnerPoolSQLHDB{row: runnerPoolSQLHRow{err: sentinel}}).CountRunners(context.Background(), "")
	require.ErrorIs(t, err, sentinel)
	execQ := New(runnerPoolSQLHDB{execErr: sentinel})
	_, err = execQ.CleanupStaleRunners(context.Background(), pgtype.Interval{})
	require.ErrorIs(t, err, sentinel)
	_, err = execQ.ReleaseRunner(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
}

func runnerPoolSQLHCreateRunner(t *testing.T, q *Queries, pool DBTX, status string, heartbeat time.Time) int64 {
	t.Helper()
	runner, err := q.UpsertRunner(context.Background(), UpsertRunnerParams{Name: "runner-h-" + status + "-" + randSlug(t), Metadata: json.RawMessage(`{"h":true}`)})
	require.NoError(t, err)
	mustExec(t, pool, `UPDATE runner_pool SET status = $1, last_heartbeat_at = $2, updated_at = $2 WHERE id = $3`, status, heartbeat, runner.ID)
	return runner.ID
}

func runnerPoolSQLHHasRunner(rows []RunnerPool, id int64) bool {
	for _, row := range rows {
		if row.ID == id {
			return true
		}
	}
	return false
}
