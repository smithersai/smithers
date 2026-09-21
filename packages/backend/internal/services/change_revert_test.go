package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type changeRevertTestQueries struct {
	landedChangeset    db.Changeset
	landedChangesetErr error
	mergedLanding      db.GetMergedLandingRequestForChangeRow
	mergedLandingErr   error
	createdLanding     db.LandingRequest
	members            []db.ChangesetMember
	repos              map[int64]db.Repository
	org                db.Organization
}

func (q *changeRevertTestQueries) GetLandedChangesetForChange(context.Context, db.GetLandedChangesetForChangeParams) (db.Changeset, error) {
	return q.landedChangeset, q.landedChangesetErr
}
func (q *changeRevertTestQueries) GetMergedLandingRequestForChange(context.Context, db.GetMergedLandingRequestForChangeParams) (db.GetMergedLandingRequestForChangeRow, error) {
	return q.mergedLanding, q.mergedLandingErr
}
func (q *changeRevertTestQueries) GetLandingRequestByNumber(context.Context, db.GetLandingRequestByNumberParams) (db.LandingRequest, error) {
	return q.createdLanding, nil
}
func (q *changeRevertTestQueries) ListChangesetMembers(context.Context, int64) ([]db.ChangesetMember, error) {
	return q.members, nil
}
func (q *changeRevertTestQueries) GetRepoByID(_ context.Context, id int64) (db.Repository, error) {
	repo, ok := q.repos[id]
	if !ok {
		return db.Repository{}, pgx.ErrNoRows
	}
	return repo, nil
}
func (q *changeRevertTestQueries) GetOrgByID(context.Context, int64) (db.Organization, error) {
	return q.org, nil
}

type changeRevertBackoutCall struct {
	owner, repo, changeID string
	req                   repohost.BackoutChangeRequest
}

type changeRevertTestRepoHost struct {
	getErr       error
	backoutCalls []changeRevertBackoutCall
	backouts     map[string]repohost.Change
}

func (r *changeRevertTestRepoHost) GetChange(context.Context, string, string, string) (repohost.Change, error) {
	return repohost.Change{ChangeID: "original", CommitID: "current"}, r.getErr
}
func (r *changeRevertTestRepoHost) BackoutChange(_ context.Context, owner, repo, changeID string, req repohost.BackoutChangeRequest) (repohost.Change, error) {
	r.backoutCalls = append(r.backoutCalls, changeRevertBackoutCall{owner: owner, repo: repo, changeID: changeID, req: req})
	return r.backouts[repo], nil
}

type changeRevertTestRecorder struct {
	recorded []repohost.Change
	sources  []string
}

func (r *changeRevertTestRecorder) RecordGeneratedChange(_ context.Context, _ int64, change repohost.Change, source string) error {
	r.recorded = append(r.recorded, change)
	r.sources = append(r.sources, source)
	return nil
}

type changeRevertTestLandingCreator struct {
	input CreateLandingRequestInput
}

func (l *changeRevertTestLandingCreator) CreateLandingRequest(_ context.Context, _ *db.User, _, _ string, input CreateLandingRequestInput) (LandingRequestResponse, error) {
	l.input = input
	return LandingRequestResponse{Number: 17}, nil
}

type changeRevertTestChangesetCreator struct {
	orgName string
	input   CreateChangesetInput
}

func (c *changeRevertTestChangesetCreator) CreateChangeset(_ context.Context, _ *db.User, orgName string, input CreateChangesetInput) (ChangesetResponse, error) {
	c.orgName, c.input = orgName, input
	return ChangesetResponse{ID: 88, ChangeID: "reverting-superproject"}, nil
}

func TestChangeRevertServiceCreatesBackoutAndLandingRequest(t *testing.T) {
	queries := &changeRevertTestQueries{
		landedChangesetErr: pgx.ErrNoRows,
		mergedLanding: db.GetMergedLandingRequestForChangeRow{
			ID: 4, TargetBookmark: "main", LandedRevision: "landed-commit",
		},
		createdLanding: db.LandingRequest{ID: 91, Number: 17},
	}
	repoHost := &changeRevertTestRepoHost{backouts: map[string]repohost.Change{
		"demo": {ChangeID: "reverting-change", CommitID: "reverting-commit"},
	}}
	recorder := &changeRevertTestRecorder{}
	landings := &changeRevertTestLandingCreator{}
	service := NewChangeRevertService(queries, repoHost, landings, nil, recorder)

	got, err := service.RevertChange(context.Background(), &db.User{ID: 7}, 42, "alice", "demo", "abcdefghijk")
	require.NoError(t, err)
	assert.Equal(t, ChangeRevertResponse{ChangeID: "reverting-change", LandingRequestID: 91, LandingRequestNumber: 17}, got)
	require.Len(t, repoHost.backoutCalls, 1)
	assert.Equal(t, changeRevertBackoutCall{
		owner: "alice", repo: "demo", changeID: "abcdefghijk",
		req: repohost.BackoutChangeRequest{Revision: "landed-commit", TargetBookmark: "main"},
	}, repoHost.backoutCalls[0])
	assert.Equal(t, []string{"revert"}, recorder.sources)
	assert.Equal(t, "Revert abcdefgh", landings.input.Title)
	assert.Equal(t, "main", landings.input.TargetBookmark)
	assert.Equal(t, []string{"reverting-change"}, landings.input.ChangeIDs)
}

func TestChangeRevertServiceRejectsUnlandedChange(t *testing.T) {
	queries := &changeRevertTestQueries{landedChangesetErr: pgx.ErrNoRows, mergedLandingErr: pgx.ErrNoRows}
	repoHost := &changeRevertTestRepoHost{backouts: map[string]repohost.Change{}}
	service := NewChangeRevertService(queries, repoHost, &changeRevertTestLandingCreator{}, nil, &changeRevertTestRecorder{})

	_, err := service.RevertChange(context.Background(), &db.User{ID: 7}, 42, "alice", "demo", "unlanded")
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 409, apiErr.Status)
	assert.Empty(t, repoHost.backoutCalls)
}

func TestChangeRevertServiceRevertsEveryLandedChangesetMember(t *testing.T) {
	queries := &changeRevertTestQueries{
		landedChangeset: db.Changeset{ID: 5, OrganizationID: 2, ChangeID: "original-superproject", TargetBookmark: "main", State: "landed"},
		org:             db.Organization{ID: 2, Name: "acme"},
		members: []db.ChangesetMember{
			{RepositoryID: 10, ChangeID: "api-change", CommitID: "api-pinned-revision", LandedCommitID: "api-landing-merge", TargetBookmark: "main"},
			{RepositoryID: 11, ChangeID: "web-change", CommitID: "web-pinned-revision", LandedCommitID: "web-landing-merge", TargetBookmark: "release"},
		},
		repos: map[int64]db.Repository{
			10: {ID: 10, Name: "api"},
			11: {ID: 11, Name: "web"},
		},
	}
	repoHost := &changeRevertTestRepoHost{backouts: map[string]repohost.Change{
		"api": {ChangeID: "api-revert", CommitID: "api-revert-commit"},
		"web": {ChangeID: "web-revert", CommitID: "web-revert-commit"},
	}}
	recorder := &changeRevertTestRecorder{}
	changesets := &changeRevertTestChangesetCreator{}
	service := NewChangeRevertService(queries, repoHost, nil, changesets, recorder)

	got, err := service.RevertChange(context.Background(), &db.User{ID: 7}, 10, "acme", "api", "api-change")
	require.NoError(t, err)
	assert.Equal(t, ChangeRevertResponse{ChangeID: "reverting-superproject", ChangesetID: 88}, got)
	assert.Equal(t, "acme", changesets.orgName)
	assert.Equal(t, "Revert original", changesets.input.Description)
	assert.Equal(t, "main", changesets.input.TargetBookmark)
	assert.Equal(t, []ChangesetMemberInput{
		{Repo: "api", ChangeID: "api-revert", TargetBookmark: "main"},
		{Repo: "web", ChangeID: "web-revert", TargetBookmark: "release"},
	}, changesets.input.Members)
	assert.Equal(t, []repohost.BackoutChangeRequest{
		{Revision: "api-pinned-revision", TargetBookmark: "main"},
		{Revision: "web-pinned-revision", TargetBookmark: "release"},
	}, []repohost.BackoutChangeRequest{repoHost.backoutCalls[0].req, repoHost.backoutCalls[1].req})
	assert.Equal(t, []string{"revert", "revert"}, recorder.sources)
}

func TestChangeRevertServiceDoesNotComposeConflictedChangesetBackout(t *testing.T) {
	queries := &changeRevertTestQueries{
		landedChangeset: db.Changeset{ID: 5, OrganizationID: 2, ChangeID: "original", State: "landed"},
		org:             db.Organization{ID: 2, Name: "acme"},
		members:         []db.ChangesetMember{{RepositoryID: 10, ChangeID: "api-change", CommitID: "pinned", LandedCommitID: "landing-merge", TargetBookmark: "main"}},
		repos:           map[int64]db.Repository{10: {ID: 10, Name: "api"}},
	}
	repoHost := &changeRevertTestRepoHost{backouts: map[string]repohost.Change{
		"api": {ChangeID: "conflicted-revert", HasConflict: true},
	}}
	changesets := &changeRevertTestChangesetCreator{}
	service := NewChangeRevertService(queries, repoHost, nil, changesets, &changeRevertTestRecorder{})

	_, err := service.RevertChange(context.Background(), &db.User{ID: 7}, 10, "acme", "api", "api-change")
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 409, apiErr.Status)
	assert.Empty(t, changesets.input.Members)
}
