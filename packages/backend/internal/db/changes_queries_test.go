package db

import (
	"context"
	"strconv"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUpsertChange_CreatesAndUpdates(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "change-upsert-user")
	repoID := mustCreateRepo(t, pool, userID, "change-upsert-repo")

	created, err := q.UpsertChange(context.Background(), UpsertChangeParams{
		RepositoryID:    repoID,
		ChangeID:        "kabc123",
		CommitID:        "commit-1",
		Description:     "initial",
		AuthorName:      "Alice",
		AuthorEmail:     "alice@example.com",
		HasConflict:     false,
		IsEmpty:         false,
		ParentChangeIds: []byte(`[]`),
	})
	require.NoError(t, err)
	assert.Equal(t, "commit-1", created.CommitID)
	assert.Equal(t, "initial", created.Description)

	updated, err := q.UpsertChange(context.Background(), UpsertChangeParams{
		RepositoryID:    repoID,
		ChangeID:        "kabc123",
		CommitID:        "commit-2",
		Description:     "updated",
		AuthorName:      "Alice",
		AuthorEmail:     "alice@example.com",
		HasConflict:     true,
		IsEmpty:         false,
		ParentChangeIds: []byte(`["kparent"]`),
	})
	require.NoError(t, err)
	assert.Equal(t, created.ID, updated.ID)
	assert.Equal(t, "commit-2", updated.CommitID)
	assert.Equal(t, "updated", updated.Description)
	assert.True(t, updated.HasConflict)
}

func TestGetChangeByChangeID_ReturnsStableChange(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "change-get-user")
	repoID := mustCreateRepo(t, pool, userID, "change-get-repo")

	_, err := q.UpsertChange(context.Background(), UpsertChangeParams{
		RepositoryID:    repoID,
		ChangeID:        "kstable1",
		CommitID:        "commit-stable",
		Description:     "stable",
		AuthorName:      "Stable",
		AuthorEmail:     "stable@example.com",
		HasConflict:     false,
		IsEmpty:         false,
		ParentChangeIds: []byte(`[]`),
	})
	require.NoError(t, err)

	got, err := q.GetChangeByChangeID(context.Background(), GetChangeByChangeIDParams{
		RepositoryID: repoID,
		ChangeID:     "kstable1",
	})
	require.NoError(t, err)
	assert.Equal(t, "kstable1", got.ChangeID)
	assert.Equal(t, "commit-stable", got.CommitID)
}

func TestChangeLandingProvenance_ReturnsLanderAndLatestApprovalRevision(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()

	authorID := mustCreateUser(t, pool, "change-landed-author")
	landerID := mustCreateUser(t, pool, "change-landed-maintainer")
	reviewerID := mustCreateUser(t, pool, "change-landed-reviewer")
	repoID := mustCreateRepo(t, pool, authorID, "change-landed-repo")
	_, err := q.UpsertChange(ctx, UpsertChangeParams{
		RepositoryID: repoID, ChangeID: "klanded", CommitID: "commit-3", ParentChangeIds: []byte(`[]`),
	})
	require.NoError(t, err)

	landing, err := q.CreateLandingRequest(ctx, CreateLandingRequestParams{
		RepositoryID: repoID, Title: "land me", AuthorID: authorID,
		TargetBookmark: "main", StackSize: 1,
	})
	require.NoError(t, err)
	_, err = q.AddLandingRequestChange(ctx, AddLandingRequestChangeParams{
		LandingRequestID: landing.ID, ChangeID: "klanded", PositionInStack: 1,
	})
	require.NoError(t, err)
	stack, err := q.GetChangeStack(ctx, GetChangeStackParams{
		RepositoryID: repoID, ChangeID: "klanded",
	})
	require.NoError(t, err)
	assert.Equal(t, landing.ID, stack.LandingRequestID)
	assert.Equal(t, landing.Number, stack.LandingRequestNumber)
	for _, snapshot := range []string{
		`{"klanded":{"commit_id":"commit-1","seq":1}}`,
		`{"klanded":{"commit_id":"commit-3","seq":3}}`,
	} {
		_, err = q.CreateLandingRequestReview(ctx, CreateLandingRequestReviewParams{
			LandingRequestID: landing.ID,
			ReviewerID:       pgtype.Int8{Int64: reviewerID, Valid: true},
			Type:             "approve",
			ChangeRevisions:  []byte(snapshot),
		})
		require.NoError(t, err)
	}
	// Historical/corrupt self-approvals must never be presented as satisfying
	// the non-author review audit property.
	_, err = q.CreateLandingRequestReview(ctx, CreateLandingRequestReviewParams{
		LandingRequestID: landing.ID,
		ReviewerID:       pgtype.Int8{Int64: authorID, Valid: true},
		Type:             "approve",
		ChangeRevisions:  []byte(`{"klanded":{"commit_id":"commit-3","seq":3}}`),
	})
	require.NoError(t, err)

	_, err = q.EnqueueLandingRequest(ctx, EnqueueLandingRequestParams{
		ID: landing.ID, QueuedBy: pgtype.Int8{Int64: landerID, Valid: true},
		TargetBookmark: "main", SourceBookmark: "",
	})
	require.NoError(t, err)
	_, err = q.MergeLandingRequest(ctx, landing.ID)
	require.NoError(t, err)

	provenance, err := q.GetChangeLandingProvenance(ctx, GetChangeLandingProvenanceParams{
		RepositoryID: repoID, ChangeID: "klanded",
	})
	require.NoError(t, err)
	assert.Equal(t, landing.ID, provenance.LandingRequestID)
	assert.Equal(t, landing.Number, provenance.LandingRequestNumber)
	assert.Equal(t, "change-landed-maintainer", provenance.LandedBy)
	assert.False(t, provenance.LandedAt.IsZero())

	approvers, err := q.ListChangeLandingApprovers(ctx, ListChangeLandingApproversParams{
		LandingRequestID: landing.ID, ChangeID: "klanded",
	})
	require.NoError(t, err)
	assert.Equal(t, []ListChangeLandingApproversRow{{Login: "change-landed-reviewer", Seq: 3}}, approvers)
}

func TestRecordChangeRevision_SequencesRewritesAndIsIdempotent(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()

	userID := mustCreateUser(t, pool, "change-revision-user")
	repoID := mustCreateRepo(t, pool, userID, "change-revision-repo")
	_, err := q.UpsertChange(ctx, UpsertChangeParams{
		RepositoryID: repoID, ChangeID: "krevision", CommitID: "commit-1",
		ParentChangeIds: []byte(`[]`),
	})
	require.NoError(t, err)

	first, err := q.RecordChangeRevision(ctx, RecordChangeRevisionParams{
		RepositoryID: repoID, ChangeID: "krevision", CommitID: "commit-1",
		ParentCommitID: "parent-at-rev-1", Source: "push",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), first.Seq)
	assert.Empty(t, first.OperationIds)

	duplicate, err := q.RecordChangeRevision(ctx, RecordChangeRevisionParams{
		RepositoryID: repoID, ChangeID: "krevision", CommitID: "commit-1",
		ParentCommitID: "must-not-replace-parent", Source: "agent", OperationIds: []string{"forged"},
	})
	require.NoError(t, err)
	assert.Equal(t, first.ID, duplicate.ID)
	assert.Equal(t, "parent-at-rev-1", duplicate.ParentCommitID)
	assert.Equal(t, "push", duplicate.Source)
	assert.Empty(t, duplicate.OperationIds)

	_, err = q.UpsertChange(ctx, UpsertChangeParams{
		RepositoryID: repoID, ChangeID: "krevision", CommitID: "commit-2",
		ParentChangeIds: []byte(`[]`),
	})
	require.NoError(t, err)
	second, err := q.RecordChangeRevision(ctx, RecordChangeRevisionParams{
		RepositoryID: repoID, ChangeID: "krevision", CommitID: "commit-2",
		ParentCommitID: "parent-at-rev-2", Source: "rebase", OperationIds: []string{"op-2"},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(2), second.Seq)

	undo, err := q.RecordChangeRevision(ctx, RecordChangeRevisionParams{
		RepositoryID: repoID, ChangeID: "krevision", CommitID: "commit-1",
		ParentCommitID: "parent-at-undo", Source: "undo", OperationIds: []string{"undo-op"},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(3), undo.Seq)
	assert.NotEqual(t, first.ID, undo.ID)
	assert.Equal(t, "undo", undo.Source)
	assert.Equal(t, []string{"undo-op"}, undo.OperationIds)

	revisions, err := q.ListChangeRevisions(ctx, ListChangeRevisionsParams{RepositoryID: repoID, ChangeID: "krevision"})
	require.NoError(t, err)
	require.Len(t, revisions, 3)
	assert.Equal(t, "parent-at-rev-1", revisions[0].ParentCommitID)
	assert.Equal(t, "parent-at-rev-2", revisions[1].ParentCommitID)
	assert.Equal(t, "parent-at-undo", revisions[2].ParentCommitID)
}

func TestListChangeReviews_ReturnsRevisionAnchorsAndLastReviewedSeq(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()

	authorID := mustCreateUser(t, pool, "change-review-author")
	reviewerID := mustCreateUser(t, pool, "change-review-human")
	repoID := mustCreateRepo(t, pool, authorID, "change-review-repo")
	_, err := q.UpsertChange(ctx, UpsertChangeParams{
		RepositoryID: repoID, ChangeID: "kreview", CommitID: "commit-2", ParentChangeIds: []byte(`[]`),
	})
	require.NoError(t, err)

	landing := mustCreateLandingRequest(t, q, repoID, authorID, "review revisions")
	_, err = q.AddLandingRequestChange(ctx, AddLandingRequestChangeParams{
		LandingRequestID: landing.ID, ChangeID: "kreview", PositionInStack: 1,
	})
	require.NoError(t, err)

	for _, revision := range []string{
		`{"kreview":{"commit_id":"commit-1","seq":1}}`,
		`{"kreview":{"commit_id":"commit-2","seq":2}}`,
	} {
		_, err = q.CreateLandingRequestReview(ctx, CreateLandingRequestReviewParams{
			LandingRequestID: landing.ID,
			ReviewerID:       pgtype.Int8{Int64: reviewerID, Valid: true},
			Type:             "approve",
			Body:             "LGTM",
			ChangeRevisions:  []byte(revision),
		})
		require.NoError(t, err)
	}
	dismissed, err := q.CreateLandingRequestReview(ctx, CreateLandingRequestReviewParams{
		LandingRequestID: landing.ID,
		ReviewerID:       pgtype.Int8{Int64: reviewerID, Valid: true},
		Type:             "comment",
		Body:             "superseded",
		ChangeRevisions:  []byte(`{"kreview":{"commit_id":"commit-3","seq":3}}`),
	})
	require.NoError(t, err)
	_, err = q.UpdateLandingRequestReviewState(ctx, UpdateLandingRequestReviewStateParams{ID: dismissed.ID, State: "dismissed"})
	require.NoError(t, err)

	agentSessionID := uuid.New()
	_, err = pool.Exec(ctx, `
		INSERT INTO agent_sessions (id, repository_id, user_id, title, status)
		VALUES ($1, $2, $3, 'change reviewer', 'completed')`, agentSessionID, repoID, reviewerID)
	require.NoError(t, err)
	_, err = q.CreateLandingRequestReview(ctx, CreateLandingRequestReviewParams{
		LandingRequestID: landing.ID,
		ReviewerKind:     "agent",
		AgentSessionID:   agentSessionID.String(),
		Type:             "approve",
		Verdict:          "lgtm",
		ConfidenceBucket: "low",
		Summary:          "Bounded reads hold",
		CommitID:         "commit-2",
		Body:             "Bounded reads hold",
		ChangeRevisions:  []byte(`{"kreview":{"commit_id":"commit-2","seq":2}}`),
	})
	require.NoError(t, err)

	reviews, err := q.ListChangeReviews(ctx, ListChangeReviewsParams{RepositoryID: repoID, ChangeID: "kreview"})
	require.NoError(t, err)
	require.Len(t, reviews, 3)
	assert.Equal(t, "change-review-human", reviews[0].Reviewer)
	assert.Equal(t, strconv.FormatInt(reviewerID, 10), reviews[0].ReviewerKey)
	assert.Equal(t, "human", reviews[0].ReviewerKind)
	assert.Equal(t, "approve", reviews[0].Type)
	assert.Equal(t, "approve", reviews[0].Verdict)
	assert.Equal(t, int64(1), reviews[0].Seq)
	assert.Equal(t, int64(3), reviews[0].LastReviewedSeq)
	assert.Equal(t, int64(3), reviews[1].LastReviewedSeq)
	assert.Equal(t, agentSessionID.String(), reviews[2].Reviewer)
	assert.Equal(t, agentSessionID.String(), reviews[2].ReviewerKey)
	assert.Equal(t, "agent", reviews[2].ReviewerKind)
	assert.Equal(t, "approve", reviews[2].Type)
	assert.Equal(t, "lgtm", reviews[2].Verdict)
	assert.Equal(t, "low", reviews[2].ConfidenceBucket.String)
	assert.Equal(t, "Bounded reads hold", reviews[2].Summary)
}

func TestChangeWalkthroughQueriesStorePerRevisionAndDefaultToLatest(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()

	userID := mustCreateUser(t, pool, "change-walkthrough-user")
	repoID := mustCreateRepo(t, pool, userID, "change-walkthrough-repo")
	_, err := q.UpsertChange(ctx, UpsertChangeParams{
		RepositoryID: repoID, ChangeID: "kwalkthrough", CommitID: "commit-1", ParentChangeIds: []byte(`[]`),
	})
	require.NoError(t, err)
	first, err := q.RecordChangeRevision(ctx, RecordChangeRevisionParams{
		RepositoryID: repoID, ChangeID: "kwalkthrough", CommitID: "commit-1", Source: "agent",
	})
	require.NoError(t, err)

	_, err = q.UpsertChangeWalkthrough(ctx, UpsertChangeWalkthroughParams{
		ChangeRevisionID: first.ID,
		Sections:         []byte(`[{"title":"Revision one","markdown":"Old story"}]`),
		Quiz:             []byte(`[{"question":"Old question"}]`),
	})
	require.NoError(t, err)

	_, err = q.UpsertChange(ctx, UpsertChangeParams{
		RepositoryID: repoID, ChangeID: "kwalkthrough", CommitID: "commit-2", ParentChangeIds: []byte(`[]`),
	})
	require.NoError(t, err)
	second, err := q.RecordChangeRevision(ctx, RecordChangeRevisionParams{
		RepositoryID: repoID, ChangeID: "kwalkthrough", CommitID: "commit-2", Source: "agent",
	})
	require.NoError(t, err)

	// An artifact on an older revision must not make the current revision look
	// reviewed when the optional rev query defaults to the latest revision.
	_, err = q.GetChangeWalkthrough(ctx, GetChangeWalkthroughParams{
		RepositoryID: repoID, ChangeID: "kwalkthrough", RevisionSeq: 0,
	})
	assert.ErrorIs(t, err, pgx.ErrNoRows)

	_, err = q.UpsertChangeWalkthrough(ctx, UpsertChangeWalkthroughParams{
		ChangeRevisionID: second.ID,
		Sections:         []byte(`[{"title":"Revision two","markdown":"Current story"}]`),
		Quiz:             []byte(`[]`),
	})
	require.NoError(t, err)

	latest, err := q.GetChangeWalkthrough(ctx, GetChangeWalkthroughParams{
		RepositoryID: repoID, ChangeID: "kwalkthrough", RevisionSeq: 0,
	})
	require.NoError(t, err)
	assert.JSONEq(t, `[{"title":"Revision two","markdown":"Current story"}]`, string(latest.Sections))

	historical, err := q.GetChangeWalkthrough(ctx, GetChangeWalkthroughParams{
		RepositoryID: repoID, ChangeID: "kwalkthrough", RevisionSeq: 1,
	})
	require.NoError(t, err)
	assert.JSONEq(t, `[{"title":"Revision one","markdown":"Old story"}]`, string(historical.Sections))
	assert.NotEqual(t, latest.ChangeRevisionID, historical.ChangeRevisionID)
}

func TestListChangesByRepo_Paginates(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "change-list-user")
	repoID := mustCreateRepo(t, pool, userID, "change-list-repo")

	for _, changeID := range []string{"kone", "ktwo", "kthree"} {
		_, err := q.UpsertChange(context.Background(), UpsertChangeParams{
			RepositoryID:    repoID,
			ChangeID:        changeID,
			CommitID:        "commit-" + changeID,
			Description:     changeID,
			AuthorName:      "User",
			AuthorEmail:     "user@example.com",
			HasConflict:     false,
			IsEmpty:         false,
			ParentChangeIds: []byte(`[]`),
		})
		require.NoError(t, err)
	}

	page, err := q.ListChangesByRepo(context.Background(), ListChangesByRepoParams{
		RepositoryID: repoID,
		PageOffset:   1,
		PageSize:     1,
	})
	require.NoError(t, err)
	require.Len(t, page, 1)
	assert.Equal(t, "ktwo", page[0].ChangeID)
}

func TestUpsertChange_RejectsNonArrayParentChangeIDs(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "change-bad-parent-user")
	repoID := mustCreateRepo(t, pool, userID, "change-bad-parent-repo")

	_, err := q.UpsertChange(context.Background(), UpsertChangeParams{
		RepositoryID:    repoID,
		ChangeID:        "kbadparents",
		CommitID:        "commit-bad",
		Description:     "invalid parent list",
		AuthorName:      "User",
		AuthorEmail:     "user@example.com",
		HasConflict:     false,
		IsEmpty:         false,
		ParentChangeIds: []byte(`{"not":"an array"}`),
	})
	require.Error(t, err)
}

func TestDeleteChangesByRepo_DeletesOnlyTargetRepositoryChanges(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "change-delete-user")
	repoID := mustCreateRepo(t, pool, userID, "change-delete-repo")
	otherRepoID := mustCreateRepo(t, pool, userID, "change-delete-other-repo")

	for _, tc := range []struct {
		repoID   int64
		changeID string
	}{
		{repoID: repoID, changeID: "k-del-1"},
		{repoID: repoID, changeID: "k-del-2"},
		{repoID: otherRepoID, changeID: "k-keep-1"},
	} {
		_, err := q.UpsertChange(context.Background(), UpsertChangeParams{
			RepositoryID:    tc.repoID,
			ChangeID:        tc.changeID,
			CommitID:        "commit-" + tc.changeID,
			Description:     tc.changeID,
			AuthorName:      "User",
			AuthorEmail:     "user@example.com",
			HasConflict:     false,
			IsEmpty:         false,
			ParentChangeIds: []byte(`[]`),
		})
		require.NoError(t, err)
	}

	rows, err := q.DeleteChangesByRepo(context.Background(), repoID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), rows)

	remaining, err := q.ListChangesByRepo(context.Background(), ListChangesByRepoParams{
		RepositoryID: otherRepoID,
		PageOffset:   0,
		PageSize:     10,
	})
	require.NoError(t, err)
	require.Len(t, remaining, 1)
	assert.Equal(t, "k-keep-1", remaining[0].ChangeID)

	deletedRepoRows, err := q.ListChangesByRepo(context.Background(), ListChangesByRepoParams{
		RepositoryID: repoID,
		PageOffset:   0,
		PageSize:     10,
	})
	require.NoError(t, err)
	assert.Empty(t, deletedRepoRows)
}
