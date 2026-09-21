package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestLandingAppendQueueSkipsOldWorkersAndRefusesOldReaper(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()
	user := mustCreateUser(t, pool, "append-author")
	repo := mustCreateRepo(t, pool, user, "append-repo")
	create := func(title string) LandingRequest {
		lr, err := q.CreateLandingRequest(ctx, CreateLandingRequestParams{RepositoryID: repo, AuthorID: user, Title: title, TargetBookmark: "main", StackSize: 1})
		require.NoError(t, err)
		return lr
	}
	lr := create("append")
	task, err := q.CreateLandingTask(ctx, CreateLandingTaskParams{LandingRequestID: lr.ID, RepositoryID: repo, Priority: 1, AppendRequest: []byte(`{"append":{"source_commit_id":"b"}}`)})
	require.NoError(t, err)
	require.Equal(t, "append_pending", task.Status)
	depth, err := q.GetLandingQueueDepth(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(1), depth)
	// This is the old worker's actual eligibility predicate. It must never see
	// the new task, even though it knows nothing about append_request.
	var id int64
	err = pool.QueryRow(ctx, `SELECT id FROM landing_tasks WHERE status='pending' AND repository_id=$1`, repo).Scan(&id)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	claimed, err := q.ClaimPendingLandingTask(ctx)
	require.NoError(t, err)
	require.Equal(t, task.ID, claimed.ID)
	require.Equal(t, "running", claimed.Status)
	require.JSONEq(t, string(task.AppendRequest), string(claimed.AppendRequest))
	// The old reaper's UPDATE cannot turn a crashed append into an ordinary land.
	_, err = pool.Exec(ctx, "SAVEPOINT old_reaper")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE landing_tasks SET status='pending',available_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='running'`, task.ID)
	require.ErrorContains(t, err, "landing_tasks_append_dispatch")
	_, err = pool.Exec(ctx, "ROLLBACK TO SAVEPOINT old_reaper")
	require.NoError(t, err)
	kept, err := q.GetLandingTaskByLandingRequestID(ctx, lr.ID)
	require.NoError(t, err)
	require.Equal(t, "running", kept.Status)
	ordinary := create("ordinary")
	normal, err := q.CreateLandingTask(ctx, CreateLandingTaskParams{LandingRequestID: ordinary.ID, RepositoryID: repo, Priority: 1})
	require.NoError(t, err)
	require.Equal(t, "pending", normal.Status)
	_, err = q.ClaimPendingLandingTask(ctx)
	require.ErrorIs(t, err, pgx.ErrNoRows, "the existing one-running-task-per-repo guard still applies")
	_, err = q.MarkLandingTaskDone(ctx, task.ID)
	require.NoError(t, err)
	// The same generated upsert used by the service transaction preserves a
	// finished append receipt even when a racing ordinary enqueue reaches SQL.
	_, err = q.ResetOrCreateLandingTask(ctx, ResetOrCreateLandingTaskParams{LandingRequestID: lr.ID, RepositoryID: repo, Priority: 1})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	kept, err = q.GetLandingTaskByLandingRequestID(ctx, lr.ID)
	require.NoError(t, err)
	require.JSONEq(t, string(task.AppendRequest), string(kept.AppendRequest))
	require.Equal(t, "done", kept.Status)
	claimed, err = q.ClaimPendingLandingTask(ctx)
	require.NoError(t, err)
	require.Equal(t, normal.ID, claimed.ID)
	require.Empty(t, claimed.AppendRequest)
}
