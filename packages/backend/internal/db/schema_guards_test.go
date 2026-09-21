package db

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// These tests exercise the database-side guards that back the application's
// friendly pre-checks: the per-repo webhook cap (trg_webhooks_repo_cap), the
// per-user workspace quota (trg_workspaces_user_quota), the webhook delivery
// claim lease, and the deferred stack position constraint. All of them exist
// precisely because the application-level check-then-insert versions race.

func TestWebhookRepoCapTrigger_RejectsTwentyFirstWebhook(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))
	repoID := mustCreateRepo(t, pool, userID, uniqueTestRepoName(t))

	for i := range 20 {
		_, err := q.CreateWebhook(ctx, CreateWebhookParams{
			RepositoryID: repoID,
			Url:          "https://example.com/hook",
			Secret:       "",
			Events:       []string{"push"},
			IsActive:     true,
		})
		require.NoError(t, err, "webhook %d of 20 must be allowed", i+1)
	}

	_, err := q.CreateWebhook(ctx, CreateWebhookParams{
		RepositoryID: repoID,
		Url:          "https://example.com/hook-21",
		Secret:       "",
		Events:       []string{"push"},
		IsActive:     true,
	})
	require.Error(t, err, "21st webhook must hit the cap")
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	assert.Equal(t, "webhooks_repo_cap", pgErr.ConstraintName)
	assert.Equal(t, "23514", pgErr.Code)
}

func TestWorkspaceUserQuotaTrigger_RejectsInsertOverCap(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))
	repoID := mustCreateRepo(t, pool, userID, uniqueTestRepoName(t))

	// Fill the cap (services.MaxActiveWorkspacesPerUser = 100) with fork rows
	// across the same repo — the quota is per user, not per repo.
	mustExec(t, pool, `
		INSERT INTO workspaces (repository_id, user_id, name, is_fork, status)
		SELECT $1, $2, 'ws-' || g, TRUE, 'starting'
		FROM generate_series(1, 100) AS g`, repoID, userID)

	err := mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateWorkspace(ctx, CreateWorkspaceParams{
			RepositoryID:   repoID,
			UserID:         userID,
			Name:           "one-over",
			IsFork:         true,
			TargetBookmark: "main",
			Status:         "starting",
		})
		return err
	})
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr, "101st active workspace must hit the quota")
	assert.Equal(t, "workspaces_user_quota", pgErr.ConstraintName)

	// Failed and tombstoned rows do not consume quota.
	mustExec(t, pool, `UPDATE workspaces SET status = 'failed' WHERE user_id = $1 AND name = 'ws-1'`, userID)
	_, err = q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID:   repoID,
		UserID:         userID,
		Name:           "after-failure",
		IsFork:         true,
		TargetBookmark: "main",
		Status:         "starting",
	})
	require.NoError(t, err, "a failed workspace must free quota")
}

func TestClaimDueWebhookDeliveries_LeasesClaimedRows(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))
	repoID := mustCreateRepo(t, pool, userID, uniqueTestRepoName(t))

	hook, err := q.CreateWebhook(ctx, CreateWebhookParams{
		RepositoryID: repoID,
		Url:          "https://example.com/hook",
		Events:       []string{"push"},
		IsActive:     true,
	})
	require.NoError(t, err)
	delivery, err := q.CreateWebhookDelivery(ctx, CreateWebhookDeliveryParams{
		WebhookID: hook.ID,
		EventType: "push",
		Payload:   json.RawMessage(`{}`),
		Status:    "pending",
	})
	require.NoError(t, err)

	claimed, err := q.ClaimDueWebhookDeliveries(ctx, 10)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	assert.Equal(t, delivery.ID, claimed[0].ID)
	assert.Equal(t, int32(1), claimed[0].Attempts)
	require.True(t, claimed[0].NextRetryAt.Valid, "claim must set the lease")

	// A concurrent poller (second claim) must not see the leased row, so the
	// payload cannot be double-sent while the first worker is delivering.
	again, err := q.ClaimDueWebhookDeliveries(ctx, 10)
	require.NoError(t, err)
	assert.Empty(t, again, "leased delivery must not be claimable")

	// Completion works while the row is pending...
	require.NoError(t, q.UpdateWebhookDeliveryResult(ctx, UpdateWebhookDeliveryResultParams{
		ID:           delivery.ID,
		Status:       "success",
		ResponseBody: "ok",
	}))
	var status string
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM webhook_deliveries WHERE id = $1`, delivery.ID).Scan(&status))
	assert.Equal(t, "success", status)

	// ...but a late worker whose lease expired cannot overwrite the terminal
	// result with a stale failure.
	require.NoError(t, q.UpdateWebhookDeliveryResult(ctx, UpdateWebhookDeliveryResultParams{
		ID:           delivery.ID,
		Status:       "failed",
		ResponseBody: "stale loser",
	}))
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM webhook_deliveries WHERE id = $1`, delivery.ID).Scan(&status))
	assert.Equal(t, "success", status, "a finalized delivery must not be overwritten")
}

func TestStackChanges_DeferredPositionConstraintAllowsSwaps(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))
	repoID := mustCreateRepo(t, pool, userID, uniqueTestRepoName(t))

	stack, err := q.UpsertActiveStack(ctx, UpsertActiveStackParams{
		RepositoryID: repoID,
		UserID:       userID,
		TargetRef:    "main",
	})
	require.NoError(t, err)

	upsert := func(changeID string, position int32) error {
		_, err := q.UpsertStackChange(ctx, UpsertStackChangeParams{
			StackID:    stack.ID,
			ChangeID:   changeID,
			Position:   position,
			BranchName: "b-" + changeID,
		})
		return err
	}
	require.NoError(t, upsert("change-a", 0))
	require.NoError(t, upsert("change-b", 1))

	// Swap the two positions with per-row upserts, exactly like
	// SubmitActiveStack does inside its transaction. The transient collision
	// (a at 1 while b is still at 1) must not fail: the unique constraint is
	// DEFERRABLE INITIALLY DEFERRED and only checked at commit.
	require.NoError(t, upsert("change-a", 1))
	require.NoError(t, upsert("change-b", 0))

	// Force the deferred check now (the test transaction never commits);
	// the final state is valid so it must pass.
	_, err = pool.Exec(ctx, `SET CONSTRAINTS uq_stack_changes_stack_position IMMEDIATE`)
	require.NoError(t, err, "swapped positions must satisfy the constraint once the whole reorder has applied")

	changes, err := q.ListStackChangesByStack(ctx, stack.ID)
	require.NoError(t, err)
	require.Len(t, changes, 2)
	assert.Equal(t, "change-b", changes[0].ChangeID)
	assert.Equal(t, int32(0), changes[0].Position)
	assert.Equal(t, "change-a", changes[1].ChangeID)
	assert.Equal(t, int32(1), changes[1].Position)

	// A genuinely conflicting final state still fails.
	err = upsert("change-b", 1)
	require.Error(t, err, "a real duplicate position must be rejected")
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	assert.Equal(t, "23505", pgErr.Code)
}
