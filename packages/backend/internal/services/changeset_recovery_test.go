package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func reviewChangesetInput() CreateChangesetInput {
	return CreateChangesetInput{Members: []ChangesetMemberInput{{Repo: "api", ChangeID: "aaaa"}, {Repo: "web", ChangeID: "bbbb"}}}
}

func TestChangesetRejectsMemberWithoutRepositoryPermissions(t *testing.T) {
	q, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1}
	created, err := svc.CreateChangeset(t.Context(), actor, "acme", reviewChangesetInput())
	require.NoError(t, err)
	q.permissions = map[int64]string{}
	_, err = svc.CreateChangeset(t.Context(), actor, "acme", reviewChangesetInput())
	require.Error(t, err)
	_, err = svc.GetChangeset(t.Context(), actor, "acme", created.ID)
	require.Error(t, err)
	_, err = svc.MaterializeChangeset(t.Context(), actor.ID, created.ID)
	require.Error(t, err)
	_, err = svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, 403, apiErr.Status)
	listed, err := svc.ListChangesets(t.Context(), actor, "acme", 1, 30)
	require.NoError(t, err)
	require.Empty(t, listed)
	require.Empty(t, rh.landCalls)
}

func TestChangesetRequiresProtectedBookmarkReviews(t *testing.T) {
	q, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1}
	created, err := svc.CreateChangeset(t.Context(), actor, "acme", reviewChangesetInput())
	require.NoError(t, err)
	q.rules = map[int64][]db.ProtectedBookmark{11: {{Pattern: "main", RequireReview: true, RequireHumanApprovals: 1}}}
	_, err = svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.Error(t, err)
	require.Empty(t, rh.landCalls)
}

type lostChangesetResponse struct {
	*fakeChangesetRepoHost
	lost bool
}

func (rh *lostChangesetResponse) LandChanges(ctx context.Context, owner, repo string, req repohost.LandRequest) (repohost.LandResult, error) {
	result, err := rh.fakeChangesetRepoHost.LandChanges(ctx, owner, repo, req)
	if err == nil && !req.LookupOnly && !rh.lost {
		rh.lost = true
		return repohost.LandResult{}, errors.New("connection lost after storage commit")
	}
	return result, err
}
func TestChangesetRecoversLostResponseWithoutLandingTwice(t *testing.T) {
	q, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1}
	created, err := svc.CreateChangeset(t.Context(), actor, "acme", reviewChangesetInput())
	require.NoError(t, err)
	svc = NewChangesetService(q, &lostChangesetResponse{fakeChangesetRepoHost: rh}, nil, nil)
	_, err = svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.Error(t, err)
	require.Equal(t, "landing", q.changesets[created.ID].State)
	landed, err := svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.NoError(t, err)
	require.Equal(t, "landed", landed.State)
	require.Len(t, rh.landCalls, 3)
}

type interleavedChangesetUpdate struct{ *fakeChangesetRepoHost }

func (rh *interleavedChangesetUpdate) LandChanges(ctx context.Context, owner, repo string, req repohost.LandRequest) (repohost.LandResult, error) {
	if repo == "web" && !req.LookupOnly {
		rh.bookmarks["acme/api/main"] = repohost.Bookmark{Name: "main", TargetChangeID: "concurrent", TargetCommitID: "concurrent-commit"}
		return repohost.LandResult{}, &repohost.StatusError{StatusCode: 409, Message: "second member conflicts"}
	}
	return rh.fakeChangesetRepoHost.LandChanges(ctx, owner, repo, req)
}
func TestChangesetRollbackPreservesConcurrentBookmarkUpdate(t *testing.T) {
	q, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1}
	created, err := svc.CreateChangeset(t.Context(), actor, "acme", reviewChangesetInput())
	require.NoError(t, err)
	svc = NewChangesetService(q, &interleavedChangesetUpdate{rh}, nil, nil)
	_, err = svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.ErrorContains(t, err, "rollback incomplete")
	require.Equal(t, "concurrent-commit", rh.bookmarks["acme/api/main"].TargetCommitID)
	require.Equal(t, "failed", q.changesets[created.ID].State)
}

type changesetFinalizeFailure struct {
	*fakeChangesetQueries
	failed bool
}

func (q *changesetFinalizeFailure) MarkChangesetLanded(ctx context.Context, arg db.MarkChangesetLandedParams) (db.Changeset, error) {
	if !q.failed {
		q.failed = true
		return db.Changeset{}, errors.New("database temporarily unavailable")
	}
	return q.fakeChangesetQueries.MarkChangesetLanded(ctx, arg)
}
func TestChangesetRecoversFinalizationWithoutMovingBookmarks(t *testing.T) {
	q, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1}
	created, err := svc.CreateChangeset(t.Context(), actor, "acme", reviewChangesetInput())
	require.NoError(t, err)
	svc = NewChangesetService(&changesetFinalizeFailure{fakeChangesetQueries: q}, rh, nil, nil)
	_, err = svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.Error(t, err)
	landed, err := svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.NoError(t, err)
	require.Equal(t, "landed", landed.State)
	require.Len(t, rh.landCalls, 3)
}

func TestChangesetRejectsUnjournaledLegacyLanding(t *testing.T) {
	q, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1}
	created, err := svc.CreateChangeset(t.Context(), actor, "acme", reviewChangesetInput())
	require.NoError(t, err)
	cs := q.changesets[created.ID]
	cs.State, cs.LandingPlan = "landing", nil
	q.changesets[created.ID] = cs
	_, err = svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.ErrorContains(t, err, "no recovery plan")
	require.Empty(t, rh.landCalls)
}
