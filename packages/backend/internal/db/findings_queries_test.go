package db

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func createFindingTestRevision(t *testing.T, q *Queries, repositoryID int64, changeID, commitID string) ChangeRevision {
	t.Helper()
	ctx := context.Background()
	_, err := q.UpsertChange(ctx, UpsertChangeParams{
		RepositoryID:    repositoryID,
		ChangeID:        changeID,
		CommitID:        commitID,
		ParentChangeIds: []byte(`[]`),
	})
	require.NoError(t, err)
	revision, err := q.RecordChangeRevision(ctx, RecordChangeRevisionParams{
		RepositoryID: repositoryID,
		ChangeID:     changeID,
		CommitID:     commitID,
		Source:       "push",
	})
	require.NoError(t, err)
	return revision
}

func TestAnalyzerRuns_UpsertAndListByRevision(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()
	userID := mustCreateUser(t, pool, "analyzer-runs-user")
	repoID := mustCreateRepo(t, pool, userID, "analyzer-runs-repo")
	first := createFindingTestRevision(t, q, repoID, "change-runs", "commit-1")

	started := time.Date(2026, 9, 2, 15, 0, 0, 0, time.UTC)
	run, err := q.UpsertAnalyzerRun(ctx, UpsertAnalyzerRunParams{
		RepositoryID: repoID,
		ChangeID:     "change-runs",
		RevisionSeq:  first.Seq,
		Name:         "security",
		State:        "running",
		StartedAt:    pgtype.Timestamptz{Time: started, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "running", run.State)

	paused, err := q.UpsertAnalyzerRun(ctx, UpsertAnalyzerRunParams{
		RepositoryID: repoID,
		ChangeID:     "change-runs",
		RevisionSeq:  first.Seq,
		Name:         "security",
		State:        "paused",
		StartedAt:    pgtype.Timestamptz{Time: started, Valid: true},
		PausedBy:     pgtype.Text{String: "kill-switch", Valid: true},
		PausedReason: pgtype.Text{String: "not-useful threshold exceeded", Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, run.ID, paused.ID)
	assert.Equal(t, "kill-switch", paused.PausedBy.String)

	runs, err := q.ListAnalyzerRunsForChange(ctx, ListAnalyzerRunsForChangeParams{
		RepositoryID: repoID,
		ChangeID:     "change-runs",
		RevisionSeq:  pgtype.Int8{Int64: first.Seq, Valid: true},
	})
	require.NoError(t, err)
	require.Len(t, runs, 1)
	assert.Equal(t, "not-useful threshold exceeded", runs[0].PausedReason.String)
}

func TestAnalyzerRuns_RequireHonestPauseAndFailureReasons(t *testing.T) {
	for _, state := range []string{"paused", "failed"} {
		t.Run(state, func(t *testing.T) {
			q, pool := newQueries(t)
			ctx := context.Background()
			userID := mustCreateUser(t, pool, "analyzer-reason-"+state+"-user")
			repoID := mustCreateRepo(t, pool, userID, "analyzer-reason-"+state+"-repo")
			revision := createFindingTestRevision(t, q, repoID, "change-"+state, "commit-1")

			_, err := q.UpsertAnalyzerRun(ctx, UpsertAnalyzerRunParams{
				RepositoryID: repoID,
				ChangeID:     "change-" + state,
				RevisionSeq:  revision.Seq,
				Name:         "security",
				State:        state,
			})
			require.Error(t, err)
		})
	}
}

func TestFindings_CreateListAndRecordFeedback(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()
	userID := mustCreateUser(t, pool, "findings-user")
	repoID := mustCreateRepo(t, pool, userID, "findings-repo")
	first := createFindingTestRevision(t, q, repoID, "change-findings", "commit-1")

	created, err := q.CreateFinding(ctx, CreateFindingParams{
		RepositoryID: repoID,
		ChangeID:     "change-findings",
		RevisionSeq:  first.Seq,
		Analyzer:     "agent review",
		Source:       "reviewer",
		Path:         "internal/service.go",
		Line:         42,
		Side:         "right",
		Severity:     "major",
		Text:         "the state transition is not atomic",
		Suggestion:   pgtype.Text{String: "wrap the writes in a transaction", Valid: true},
		AnchorHash:   pgtype.Text{String: "anchor-v1", Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, first.Seq, created.RevisionSeq)

	rows, err := q.ListFindingsForChange(ctx, ListFindingsForChangeParams{
		RepositoryID: repoID,
		ChangeID:     "change-findings",
	})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "anchor-v1", rows[0].AnchorHash.String)
	assert.False(t, rows[0].Feedback.Valid)

	updated, err := q.UpdateFindingFeedback(ctx, UpdateFindingFeedbackParams{
		Feedback:     pgtype.Text{String: "not_useful", Valid: true},
		ID:           created.ID,
		RepositoryID: repoID,
		ChangeID:     "change-findings",
	})
	require.NoError(t, err)
	assert.Equal(t, "not_useful", updated.Feedback.String)

	reviewerID := mustCreateUser(t, pool, "findings-reviewer")
	_, err = q.UpsertFindingFeedback(ctx, UpsertFindingFeedbackParams{
		FindingID: created.ID,
		UserID:    userID,
		Useful:    true,
		Note:      pgtype.Text{String: "actionable", Valid: true},
	})
	require.NoError(t, err)
	_, err = q.UpsertFindingFeedback(ctx, UpsertFindingFeedbackParams{
		FindingID: created.ID,
		UserID:    reviewerID,
		Useful:    false,
	})
	require.NoError(t, err)
	feedbackRows, err := q.ListFindingFeedbackForChange(ctx, ListFindingFeedbackForChangeParams{
		UserID:       pgtype.Int8{Int64: userID, Valid: true},
		RepositoryID: repoID,
		ChangeID:     "change-findings",
	})
	require.NoError(t, err)
	require.Len(t, feedbackRows, 1)
	assert.True(t, feedbackRows[0].CallerUseful.Bool)
	assert.Equal(t, "actionable", feedbackRows[0].CallerNote.String)
	assert.Equal(t, int64(1), feedbackRows[0].UsefulCount)
	assert.Equal(t, int64(1), feedbackRows[0].NotUsefulCount)

	metadata := []byte(`{"finding_id":` + fmt.Sprint(created.ID) + `}`)
	firstSession, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID: uuid.NewString(), RepositoryID: repoID, UserID: userID, Title: "Fix finding", Status: "active", Metadata: metadata,
	})
	require.NoError(t, err)
	active, err := q.GetActiveFindingDispatch(ctx, GetActiveFindingDispatchParams{RepositoryID: repoID, FindingID: created.ID})
	require.NoError(t, err)
	assert.Equal(t, firstSession.ID, active.ID)
	_, err = q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID: uuid.NewString(), RepositoryID: repoID, UserID: reviewerID, Title: "Duplicate fix", Status: "active", Metadata: metadata,
	})
	require.Error(t, err, "only one active session may dispatch a finding")
}
