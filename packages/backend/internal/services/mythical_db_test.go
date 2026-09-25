package services

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// TestMythicalQueriesOnProductSchema runs the hand-written SQL against the
// real product migrations, including 0025.
func TestMythicalQueriesOnProductSchema(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	var userID, repoID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('canary', 'canary') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name) VALUES ($1, 'smithers', 'smithers') RETURNING id`, userID).Scan(&repoID))

	row, err := q.RequestMythicalBootstrap(ctx, repoID, userID, 100, false)
	require.NoError(t, err)
	assert.Equal(t, "bootstrapping", row.State)
	assert.Zero(t, row.ResetGeneration)

	// A reset during a running claim: finishing the claimed reset clears only
	// its own generation, never the newer request.
	_, err = q.RequestMythicalBootstrap(ctx, repoID, userID, 50, true)
	require.NoError(t, err)
	claims, err := q.ClaimMythicalStacks(ctx, 1, 600)
	require.NoError(t, err)
	require.Len(t, claims, 1)
	claimed := claims[0]
	require.NotZero(t, claimed.ResetGeneration)
	newer, err := q.RequestMythicalBootstrap(ctx, repoID, userID, 60, true)
	require.NoError(t, err)
	require.Greater(t, newer.ResetGeneration, claimed.ResetGeneration)
	_, err = q.FinishMythicalStack(ctx, db.FinishMythicalStackParams{RepositoryID: repoID, Claim: claimed.Claim, State: "active",
		TipCommit: "t", NotesCommit: "n", LandedMain: "m", Changed: true, ClearPendingOp: true, ResetGeneration: claimed.ResetGeneration})
	require.NoError(t, err)
	after, err := q.GetMythicalStack(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, newer.ResetGeneration, after.ResetGeneration, "the newer reset stays requested")
	assert.Greater(t, after.RequestedGeneration, after.ProcessedGeneration, "and due")
	assert.EqualValues(t, 60, after.BootstrapDepth)

	// A stale claim writes nothing.
	_, err = q.FinishMythicalStack(ctx, db.FinishMythicalStackParams{RepositoryID: repoID, Claim: claimed.Claim, State: "frozen"})
	assert.ErrorIs(t, err, pgx.ErrNoRows)

	// A pending write survives a failed finish and is cleared only by one that settles it.
	claims, err = q.ClaimMythicalStacks(ctx, 1, 600)
	require.NoError(t, err)
	require.Len(t, claims, 1)
	written, err := q.SetMythicalPendingOp(ctx, repoID, claims[0].Claim, []byte(`{"kind":"fold"}`))
	require.NoError(t, err)
	require.EqualValues(t, 1, written)
	_, err = q.FinishMythicalStack(ctx, db.FinishMythicalStackParams{RepositoryID: repoID, Claim: claims[0].Claim, Failed: true, Error: "x", BackoffSeconds: 0})
	require.NoError(t, err)
	after, err = q.GetMythicalStack(ctx, repoID)
	require.NoError(t, err)
	assert.JSONEq(t, `{"kind":"fold"}`, string(after.PendingOp))

	// Changes: replace from a position; the stack's own change ids are known.
	require.NoError(t, q.ReplaceMythicalChanges(ctx, repoID, 0, []db.MythicalChange{
		{Position: 0, ChangeID: "zz", CommitID: "c0", Kind: "bootstrap"}, {Position: 1, ChangeID: "yy", CommitID: "c1", Kind: "fold"}}))
	require.NoError(t, q.ReplaceMythicalChanges(ctx, repoID, 1, []db.MythicalChange{{Position: 1, ChangeID: "xx", CommitID: "c2", Kind: "fold"}}))
	recent, err := q.ListRecentMythicalChanges(ctx, repoID, 10)
	require.NoError(t, err)
	require.Len(t, recent, 2)
	assert.Equal(t, "xx", recent[0].ChangeID)
	owned, err := q.IsMythicalChange(ctx, repoID, "zz")
	require.NoError(t, err)
	assert.True(t, owned)
	owned, err = q.IsMythicalChange(ctx, repoID, "yy")
	require.NoError(t, err)
	assert.False(t, owned)

	// Event hints reach a listener of the repository's channel.
	conn, err := pool.Acquire(ctx)
	require.NoError(t, err)
	defer conn.Release()
	_, err = conn.Exec(ctx, "LISTEN mythical_"+strconv.FormatInt(repoID, 10))
	require.NoError(t, err)
	require.NoError(t, q.NotifyMythical(ctx, repoID, `{"generation":7,"kind":"stack"}`))
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	notification, err := conn.Conn().WaitForNotification(waitCtx)
	require.NoError(t, err)
	assert.JSONEq(t, `{"generation":7,"kind":"stack"}`, notification.Payload)

	// Deleting the actor keeps the repository's stack.
	_, err = pool.Exec(ctx, `DELETE FROM users WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM repositories WHERE user_id = $1)`, userID)
	require.NoError(t, err)
	var otherUser int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('other', 'other') RETURNING id`).Scan(&otherUser))
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET actor_user_id = $2 WHERE repository_id = $1`, repoID, otherUser)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, otherUser)
	require.NoError(t, err)
	after, err = q.GetMythicalStack(ctx, repoID)
	require.NoError(t, err)
	assert.False(t, after.ActorUserID.Valid)
}
