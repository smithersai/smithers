package db

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// repo_push_events is the durable inbox for repo-host push callbacks: a
// delivery id is stored once, claims are fenced on their attempt, and a
// recorded step survives a retry.
func TestRepoPushEventsQueueLifecycle(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	_, repoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), uniqueTestRepoName(t))

	params := InsertRepoPushEventParams{
		DeliveryID: "d-1", RepositoryID: repoID, Owner: "alice", Repo: "demo",
		RefName: "refs/heads/main", BeforeSha: "aaa", CommitSha: "bbb", PusherID: 7, PusherLogin: "alice",
	}
	inserted, err := q.InsertRepoPushEvent(ctx, params)
	require.NoError(t, err)
	require.EqualValues(t, 1, inserted)
	inserted, err = q.InsertRepoPushEvent(ctx, params)
	require.NoError(t, err)
	require.EqualValues(t, 0, inserted, "a redelivered delivery_id must not store a second event")

	claimed, err := q.ClaimPendingRepoPushEvents(ctx, 10)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	event := claimed[0]
	require.Equal(t, "processing", event.Status)
	require.EqualValues(t, 1, event.Attempts)
	require.Equal(t, "bbb", event.CommitSha)
	require.Empty(t, event.StepsDone)

	again, err := q.ClaimPendingRepoPushEvents(ctx, 10)
	require.NoError(t, err)
	require.Empty(t, again, "a processing event is not claimed twice")

	n, err := q.MarkRepoPushEventStepDone(ctx, MarkRepoPushEventStepDoneParams{Step: "webhooks", ID: event.ID, ExpectedAttempts: 1})
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
	n, err = q.MarkRepoPushEventStepDone(ctx, MarkRepoPushEventStepDoneParams{Step: "webhooks", ID: event.ID, ExpectedAttempts: 1})
	require.NoError(t, err)
	require.EqualValues(t, 0, n, "a step is recorded once")
	n, err = q.MarkRepoPushEventStepDone(ctx, MarkRepoPushEventStepDoneParams{Step: "workflows", ID: event.ID, ExpectedAttempts: 2})
	require.NoError(t, err)
	require.EqualValues(t, 0, n, "a stale claim generation cannot record steps")

	n, err = q.RetryRepoPushEvent(ctx, RetryRepoPushEventParams{Error: "index down", BackoffSeconds: 0, ID: event.ID, ExpectedAttempts: 1})
	require.NoError(t, err)
	require.EqualValues(t, 1, n)

	claimed, err = q.ClaimPendingRepoPushEvents(ctx, 10)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	require.EqualValues(t, 2, claimed[0].Attempts)
	require.Equal(t, []string{"webhooks"}, claimed[0].StepsDone, "recorded steps survive the retry")

	n, err = q.MarkRepoPushEventDone(ctx, MarkRepoPushEventDoneParams{ID: event.ID, ExpectedAttempts: 1})
	require.NoError(t, err)
	require.EqualValues(t, 0, n, "a lost claim cannot finish the event")
	n, err = q.TouchRepoPushEvent(ctx, TouchRepoPushEventParams{ID: event.ID, ExpectedAttempts: 2})
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
	n, err = q.MarkRepoPushEventDone(ctx, MarkRepoPushEventDoneParams{ID: event.ID, ExpectedAttempts: 2})
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
}

func TestRepoPushEventsResetStalledAndFail(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	_, repoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), uniqueTestRepoName(t))
	_, err := q.InsertRepoPushEvent(ctx, InsertRepoPushEventParams{DeliveryID: "d-stall", RepositoryID: repoID, Owner: "alice", Repo: "demo", RefName: "refs/heads/main"})
	require.NoError(t, err)
	claimed, err := q.ClaimPendingRepoPushEvents(ctx, 1)
	require.NoError(t, err)
	require.Len(t, claimed, 1)

	_, err = tx.Exec(ctx, `UPDATE repo_push_events SET updated_at = NOW() - interval '1 hour' WHERE id = $1`, claimed[0].ID)
	require.NoError(t, err)
	reset, err := q.ResetStalledRepoPushEvents(ctx, 300)
	require.NoError(t, err)
	require.EqualValues(t, 1, reset)

	claimed, err = q.ClaimPendingRepoPushEvents(ctx, 1)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	n, err := q.MarkRepoPushEventFailed(ctx, MarkRepoPushEventFailedParams{Error: "gave up", ID: claimed[0].ID, ExpectedAttempts: 2})
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
	var status, lastErr string
	require.NoError(t, tx.QueryRow(ctx, `SELECT status, error FROM repo_push_events WHERE id = $1`, claimed[0].ID).Scan(&status, &lastErr))
	require.Equal(t, "failed", status)
	require.Equal(t, "gave up", lastErr)
}
