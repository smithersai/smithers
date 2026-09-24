package db

import (
	"context"
	"encoding/hex"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func mustCreatePairSession(t *testing.T, q *Queries, ownerID int64, sourceWS string) PairSession {
	t.Helper()
	sess, err := q.CreatePairSession(context.Background(), CreatePairSessionParams{
		ID:                randSlug(t),
		OwnerUserID:       ownerID,
		SourceWorkspaceID: sourceWS,
		AccessMode:        "restricted",
	})
	require.NoError(t, err)
	return sess
}

// TestPairSession_OneLivePerSource proves the partial-unique live-session index:
// a second non-terminal session for the same source workspace is rejected, but
// once the first is ended a new one succeeds (so a dead fork never wedges the
// owner).
func TestPairSession_OneLivePerSource(t *testing.T) {
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, "pair-live-owner", "pair-live-repo")
	sourceWS := mustCreateWorkspace(t, pool, userID, repoID)

	first := mustCreatePairSession(t, q, userID, sourceWS)

	// The expected-violation insert runs inside a savepoint so the aborted
	// statement does not poison the outer test transaction.
	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreatePairSession(context.Background(), CreatePairSessionParams{
			ID:                randSlug(t),
			OwnerUserID:       userID,
			SourceWorkspaceID: sourceWS,
			AccessMode:        "restricted",
		})
		return err
	})

	// End the first; a fresh session then succeeds.
	_, err := q.SetPairSessionStatus(context.Background(), SetPairSessionStatusParams{ID: first.ID, Status: "ended"})
	require.NoError(t, err)

	_, err = q.CreatePairSession(context.Background(), CreatePairSessionParams{
		ID:                randSlug(t),
		OwnerUserID:       userID,
		SourceWorkspaceID: sourceWS,
		AccessMode:        "restricted",
	})
	require.NoError(t, err, "a new session should be allowed once the prior one is ended")
}

// TestPairSession_FailedDoesNotWedgeOwner proves 'failed' sessions are excluded
// from the live index, so the compensation sweep frees the source.
func TestPairSession_FailedDoesNotWedgeOwner(t *testing.T) {
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, "pair-failed-owner", "pair-failed-repo")
	sourceWS := mustCreateWorkspace(t, pool, userID, repoID)

	first := mustCreatePairSession(t, q, userID, sourceWS)
	_, err := q.SetPairSessionStatus(context.Background(), SetPairSessionStatusParams{ID: first.ID, Status: "failed"})
	require.NoError(t, err)

	_, err = q.CreatePairSession(context.Background(), CreatePairSessionParams{
		ID:                randSlug(t),
		OwnerUserID:       userID,
		SourceWorkspaceID: sourceWS,
		AccessMode:        "restricted",
	})
	require.NoError(t, err, "a failed fork must not block a fresh session")
}

// TestPairSessionMembers_OneOwner proves at most one live owner per session.
func TestPairSessionMembers_OneOwner(t *testing.T) {
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, "pair-owner-a", "pair-owner-repo")
	other := mustCreateUser(t, pool, "pair-owner-b")
	sourceWS := mustCreateWorkspace(t, pool, userID, repoID)
	sess := mustCreatePairSession(t, q, userID, sourceWS)

	_, err := q.UpsertPairSessionMember(context.Background(), UpsertPairSessionMemberParams{
		SessionID: sess.ID, UserID: userID, Role: "owner",
	})
	require.NoError(t, err)

	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.UpsertPairSessionMember(context.Background(), UpsertPairSessionMemberParams{
			SessionID: sess.ID, UserID: other, Role: "owner",
		})
		return err
	})

	// A non-owner role for the second user is fine.
	_, err = q.UpsertPairSessionMember(context.Background(), UpsertPairSessionMemberParams{
		SessionID: sess.ID, UserID: other, Role: "editor",
	})
	require.NoError(t, err)
}

// TestPairPromptQueue_ClaimCasExactlyOnce fires N concurrent claim CAS
// statements at a single queued prompt; the one-active partial-unique index
// must let exactly one win.
func TestPairPromptQueue_ClaimCasExactlyOnce(t *testing.T) {
	// This is a genuine concurrency proof: it runs against the shared pool (each
	// goroutine gets its own connection) rather than a single transaction, which
	// pgx forbids for concurrent use. Committed rows are cleaned up explicitly.
	pool := sharedPool
	q := New(pool)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	sourceWS := mustCreateWorkspace(t, pool, userID, repoID)
	sess := mustCreatePairSession(t, q, userID, sourceWS)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM pair_sessions WHERE id = $1`, sess.ID)
	})

	prompt, err := q.EnqueuePairPrompt(context.Background(), EnqueuePairPromptParams{
		SessionID: sess.ID, AuthorUserID: userID, Source: "solo", Body: "do the thing",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), prompt.Seq)

	const contenders = 8
	var wins int64
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < contenders; i++ {
		wg.Add(1)
		go func(clientNum int) {
			defer wg.Done()
			<-start
			_, err := q.ClaimPairPrompt(context.Background(), ClaimPairPromptParams{
				ID:               prompt.ID,
				SessionID:        sess.ID,
				ExecutorClientID: hex.EncodeToString([]byte{byte(clientNum)}),
				ClaimExpiresAt:   pgtype.Timestamptz{Time: time.Now().Add(30 * time.Second), Valid: true},
			})
			if err == nil {
				atomic.AddInt64(&wins, 1)
			}
		}(i)
	}
	close(start)
	wg.Wait()

	assert.Equal(t, int64(1), atomic.LoadInt64(&wins), "exactly one client must win the claim CAS")
}

// TestPairPromptQueue_RunIdIsIdempotencyMarker proves the sweep reverts an
// expired claim WITHOUT a run_id but never one WITH a run_id.
func TestPairPromptQueue_RunIdIsIdempotencyMarker(t *testing.T) {
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, "pair-runid-owner", "pair-runid-repo")
	sourceWS := mustCreateWorkspace(t, pool, userID, repoID)
	sess := mustCreatePairSession(t, q, userID, sourceWS)

	// Prompt A: claimed, expired lease, NO run_id -> should revert to queued.
	a, err := q.EnqueuePairPrompt(context.Background(), EnqueuePairPromptParams{SessionID: sess.ID, AuthorUserID: userID, Source: "solo", Body: "A"})
	require.NoError(t, err)
	_, err = q.ClaimPairPrompt(context.Background(), ClaimPairPromptParams{
		ID: a.ID, SessionID: sess.ID, ExecutorClientID: "c1",
		ClaimExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(-time.Minute), Valid: true},
	})
	require.NoError(t, err)

	swept, err := q.SweepStalePairPromptClaims(context.Background())
	require.NoError(t, err)
	require.Len(t, swept, 1)
	assert.Equal(t, a.ID, swept[0].ID)
	assert.Equal(t, "queued", swept[0].Status)

	// Prompt B: running with a run_id, expired lease -> NEVER reverted.
	b, err := q.EnqueuePairPrompt(context.Background(), EnqueuePairPromptParams{SessionID: sess.ID, AuthorUserID: userID, Source: "solo", Body: "B"})
	require.NoError(t, err)
	_, err = q.ClaimPairPrompt(context.Background(), ClaimPairPromptParams{
		ID: b.ID, SessionID: sess.ID, ExecutorClientID: "c2",
		ClaimExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(-time.Minute), Valid: true},
	})
	require.NoError(t, err)
	_, err = q.StartPairPrompt(context.Background(), StartPairPromptParams{ID: b.ID, SessionID: sess.ID, RunID: "run_real_123", ExecutorClientID: "c2"})
	require.NoError(t, err)

	swept2, err := q.SweepStalePairPromptClaims(context.Background())
	require.NoError(t, err)
	assert.Empty(t, swept2, "a row with a run_id must never be reverted by the sweep")

	got, err := q.GetPairPrompt(context.Background(), b.ID)
	require.NoError(t, err)
	assert.Equal(t, "running", got.Status)
	assert.Equal(t, "run_real_123", got.RunID.String)
}

// TestPairSessionDraft_VersionGatedApply proves a stale (lower/equal) version is
// rejected while a strictly-greater version applies.
func TestPairSessionDraft_VersionGatedApply(t *testing.T) {
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, "pair-draft-owner", "pair-draft-repo")
	sourceWS := mustCreateWorkspace(t, pool, userID, repoID)
	sess := mustCreatePairSession(t, q, userID, sourceWS)

	uid := pgtype.Int8{Int64: userID, Valid: true}
	_ = uid

	d1, err := q.UpsertPairSessionDraft(context.Background(), UpsertPairSessionDraftParams{
		SessionID: sess.ID, Content: "v1", Version: 1, UpdatedBy: pgtype.Int8{Int64: userID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), d1.Version)

	// Stale write (version 1 again) must not apply — ON CONFLICT WHERE guard
	// leaves the row unchanged and RETURNING yields no row.
	_, err = q.UpsertPairSessionDraft(context.Background(), UpsertPairSessionDraftParams{
		SessionID: sess.ID, Content: "stale", Version: 1, UpdatedBy: pgtype.Int8{Int64: userID, Valid: true},
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	cur, err := q.GetPairSessionDraft(context.Background(), sess.ID)
	require.NoError(t, err)
	assert.Equal(t, "v1", cur.Content)

	// Strictly greater version applies.
	d2, err := q.UpsertPairSessionDraft(context.Background(), UpsertPairSessionDraftParams{
		SessionID: sess.ID, Content: "v2", Version: 2, UpdatedBy: pgtype.Int8{Int64: userID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "v2", d2.Content)
	assert.Equal(t, int64(2), d2.Version)
}

// TestPairSessionLinks_OneLivePerRoleAndRotate proves amendment A: at most one
// live link per (session, role) — a view link and an edit link can coexist, a
// second live link of the same role is rejected, and revoking a role's link
// frees the slot so a fresh one can be minted (rotation).
func TestPairSessionLinks_OneLivePerRoleAndRotate(t *testing.T) {
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, "pair-links-owner", "pair-links-repo")
	sourceWS := mustCreateWorkspace(t, pool, userID, repoID)
	sess := mustCreatePairSession(t, q, userID, sourceWS)

	viewLink, err := q.CreatePairSessionLink(context.Background(), CreatePairSessionLinkParams{
		SessionID: sess.ID, Slug: randSlug(t), Role: "viewer", CreatedBy: userID,
	})
	require.NoError(t, err)

	// A concurrent edit link for the same session is allowed (different role).
	_, err = q.CreatePairSessionLink(context.Background(), CreatePairSessionLinkParams{
		SessionID: sess.ID, Slug: randSlug(t), Role: "editor", CreatedBy: userID,
	})
	require.NoError(t, err)

	// A second live viewer link violates the one-live-per-role index.
	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreatePairSessionLink(context.Background(), CreatePairSessionLinkParams{
			SessionID: sess.ID, Slug: randSlug(t), Role: "viewer", CreatedBy: userID,
		})
		return err
	})

	// Live-links listing surfaces exactly the two live links.
	links, err := q.ListLivePairSessionLinks(context.Background(), sess.ID)
	require.NoError(t, err)
	require.Len(t, links, 2)

	// Rotate the viewer link: revoke, then a fresh viewer link succeeds.
	_, err = q.RevokePairSessionLink(context.Background(), RevokePairSessionLinkParams{ID: viewLink.ID, SessionID: sess.ID})
	require.NoError(t, err)
	newSlug := randSlug(t)
	_, err = q.CreatePairSessionLink(context.Background(), CreatePairSessionLinkParams{
		SessionID: sess.ID, Slug: newSlug, Role: "viewer", CreatedBy: userID,
	})
	require.NoError(t, err, "a fresh viewer link should mint once the prior one is revoked")

	// The revoked slug no longer resolves; the new one does.
	_, err = q.GetLivePairSessionLinkBySlug(context.Background(), viewLink.Slug)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	got, err := q.GetLivePairSessionLinkBySlug(context.Background(), newSlug)
	require.NoError(t, err)
	assert.Equal(t, "viewer", got.Role)
}
