package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func TestLandingService_CreateReviewUsesClientRevision(t *testing.T) {
	actor := landingTestUser(9, "reviewer")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(_ context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(71, repo.ID, arg.Number, 42, []string{"k1", "k2"}), nil
		},
		getLandingRevisionByCommitIDFn: func(_ context.Context, arg db.GetLandingRequestChangeRevisionByCommitIDParams) (db.ChangeRevision, error) {
			assert.Equal(t, "client-commit", arg.CommitID)
			return db.ChangeRevision{RepositoryID: repo.ID, ChangeID: "k1", CommitID: arg.CommitID, Seq: 7}, nil
		},
	}

	repoHost := &mockLandingRepoHostClient{getChangeFn: func(_ context.Context, _, _, changeID string) (repohost.Change, error) {
		return repohost.Change{ChangeID: changeID, CommitID: "current-" + changeID}, nil
	}}
	review, err := NewLandingService(q, repoHost).CreateLandingReview(
		context.Background(), actor, "alice", "demo", 3,
		CreateLandingReviewInput{Type: "approve", Body: "LGTM", CommitID: "client-commit"},
	)
	require.NoError(t, err)
	assert.Equal(t, "client-commit", review.CommitID)
	assert.Equal(t, "client-commit", q.lastCreateLandingRequestReviewArg.CommitID)

	var snapshot map[string]approvalRevision
	require.NoError(t, json.Unmarshal(q.lastCreateLandingRequestReviewArg.ChangeRevisions, &snapshot))
	assert.Equal(t, approvalRevision{CommitID: "client-commit", Seq: 7}, snapshot["k1"])
	assert.Equal(t, approvalRevision{CommitID: "current-k2", Seq: 1}, snapshot["k2"])
}

func TestLandingCommentResponse_JSONRoundTripPreservesLifecycleAndAnchorState(t *testing.T) {
	original := LandingCommentResponse{
		LandingRequestComment: db.LandingRequestComment{State: "done"},
		AnchorState:           "moved",
		CurrentLine:           27,
	}

	encoded, err := json.Marshal(original)
	require.NoError(t, err)

	var keys map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(encoded, &keys))
	require.Contains(t, keys, "state")
	require.Contains(t, keys, "anchor_state")
	assert.JSONEq(t, `"done"`, string(keys["state"]))
	assert.JSONEq(t, `"moved"`, string(keys["anchor_state"]))

	var decoded LandingCommentResponse
	require.NoError(t, json.Unmarshal(encoded, &decoded))
	assert.Equal(t, original.State, decoded.State)
	assert.Equal(t, original.AnchorState, decoded.AnchorState)
	assert.Equal(t, original.CurrentLine, decoded.CurrentLine)
}

func TestLandingService_LandRejectsChangedHead(t *testing.T) {
	actor := landingTestUser(9, "owner")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(_ context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(71, repo.ID, arg.Number, 42, []string{"k1"}), nil
		},
		getLandingRevisionByCommitIDFn: func(_ context.Context, arg db.GetLandingRequestChangeRevisionByCommitIDParams) (db.ChangeRevision, error) {
			return db.ChangeRevision{RepositoryID: repo.ID, ChangeID: "k1", CommitID: arg.CommitID, Seq: 2}, nil
		},
	}
	repoHost := &mockLandingRepoHostClient{getChangeFn: func(context.Context, string, string, string) (repohost.Change, error) {
		return repohost.Change{ChangeID: "k1", CommitID: "new-head"}, nil
	}}

	_, err := NewLandingService(q, repoHost).LandLandingRequest(
		context.Background(), actor, "alice", "demo", 3,
		LandLandingRequestInput{CommitID: "reviewed-head"},
	)
	require.Error(t, err)
	assert.Equal(t, 409, landingAPIStatus(t, err))
	assert.False(t, q.enqueueLandingRequestCalled)
}

func TestLandingService_CommentAnchorMovesThenGoesStale(t *testing.T) {
	actor := landingTestUser(9, "reviewer")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})
	oldParent := "a\nb\nc\nd\nbefore\nf\ng\nh\ni\n"
	oldRevision := "a\nb\nc\nd\ntarget\nf\ng\nh\ni\n"
	prefix := "x1\nx2\nx3\nx4\nx5\n"
	newParent := prefix + oldParent
	newRevision := prefix + oldRevision

	var stored db.LandingRequestComment
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(_ context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(71, repo.ID, arg.Number, 42, []string{"k1"}), nil
		},
		getLandingRevisionByCommitIDFn: func(_ context.Context, arg db.GetLandingRequestChangeRevisionByCommitIDParams) (db.ChangeRevision, error) {
			return db.ChangeRevision{RepositoryID: repo.ID, ChangeID: "k1", CommitID: arg.CommitID, Seq: 1}, nil
		},
		createLandingRequestCommentFn: func(_ context.Context, arg db.CreateLandingRequestCommentParams) (db.LandingRequestComment, error) {
			stored = db.LandingRequestComment{ID: 1, LandingRequestID: arg.LandingRequestID, UserID: arg.UserID, Path: arg.Path, Line: arg.Line, Side: arg.Side, Body: arg.Body, CommitID: arg.CommitID, AnchorHash: arg.AnchorHash}
			return stored, nil
		},
		listLandingRequestCommentsFn: func(context.Context, db.ListLandingRequestCommentsParams) ([]db.LandingRequestComment, error) {
			return []db.LandingRequestComment{stored}, nil
		},
	}
	repoHost := &mockLandingRepoHostClient{
		getChangeFn: func(_ context.Context, _, _, ref string) (repohost.Change, error) {
			switch ref {
			case "old-commit":
				return repohost.Change{ChangeID: "k1", CommitID: ref, ParentCommitID: "old-parent"}, nil
			default:
				return repohost.Change{ChangeID: "k1", CommitID: "new-commit", ParentCommitID: "new-parent"}, nil
			}
		},
		getChangeDiffFn: func(_ context.Context, _, _, ref string) (repohost.ChangeDiff, error) {
			return repohost.ChangeDiff{ChangeID: "k1", FileDiffs: []repohost.FileDiff{{Path: "README.md", ChangeType: "modified"}}}, nil
		},
		getFileAtChangeFn: func(_ context.Context, _, _, ref, filePath string) (repohost.FileContent, error) {
			contents := map[string]string{
				"old-parent": oldParent,
				"old-commit": oldRevision,
				"new-parent": newParent,
				"k1":         newRevision,
			}
			return repohost.FileContent{Path: filePath, Content: contents[ref]}, nil
		},
	}
	svc := NewLandingService(q, repoHost)

	created, err := svc.CreateLandingComment(context.Background(), actor, "alice", "demo", 3, CreateLandingCommentInput{
		Path: "README.md", Line: 5, Side: "right", Body: "keep this", CommitID: "old-commit",
	})
	require.NoError(t, err)
	assert.Len(t, created.AnchorHash, 64)
	assert.Equal(t, "moved", created.AnchorState)
	assert.Equal(t, int64(10), created.CurrentLine)

	newRevision = prefix + "a\nb\nc\nd\nchanged again\nf\ng\nh\ni\n"
	comments, _, err := svc.ListLandingComments(context.Background(), actor, "alice", "demo", 3, 1, 30)
	require.NoError(t, err)
	require.Len(t, comments, 1)
	assert.Equal(t, "stale", comments[0].AnchorState)
	assert.Zero(t, comments[0].CurrentLine)
}
