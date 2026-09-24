package services

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type importedRevisionLookup struct {
	LandingQuerier
	getLandingRevisionByCommitIDFn func(context.Context, db.GetLandingRequestChangeRevisionByCommitIDParams) (db.ChangeRevision, error)
	listLandingRequestChangesFn    func(context.Context, db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error)
}

func (q *importedRevisionLookup) GetLandingRequestChangeRevisionByCommitID(ctx context.Context, p db.GetLandingRequestChangeRevisionByCommitIDParams) (db.ChangeRevision, error) {
	return q.getLandingRevisionByCommitIDFn(ctx, p)
}
func (q *importedRevisionLookup) ListLandingRequestChanges(ctx context.Context, p db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
	return q.listLandingRequestChangesFn(ctx, p)
}

type importedRevisionRepoHost struct {
	LandingRepoHostClient
	getChangeFn func(context.Context, string, string, string) (repohost.Change, error)
}

func (r *importedRevisionRepoHost) GetChange(ctx context.Context, owner, repo, change string) (repohost.Change, error) {
	return r.getChangeFn(ctx, owner, repo, change)
}

type importedLandingRevisionQueries struct {
	*importedRevisionLookup
	changes   []db.UpsertChangeParams
	revisions []db.RecordChangeRevisionParams
	recordErr error
}

func (q *importedLandingRevisionQueries) UpsertChange(_ context.Context, p db.UpsertChangeParams) (db.Change, error) {
	q.changes = append(q.changes, p)
	return db.Change{RepositoryID: p.RepositoryID, ChangeID: p.ChangeID, CommitID: p.CommitID, RevisionSeq: 1}, nil
}
func (q *importedLandingRevisionQueries) RecordChangeRevision(_ context.Context, p db.RecordChangeRevisionParams) (db.ChangeRevision, error) {
	q.revisions = append(q.revisions, p)
	return db.ChangeRevision{RepositoryID: p.RepositoryID, ChangeID: p.ChangeID, CommitID: p.CommitID, ParentCommitID: p.ParentCommitID, Seq: 1}, q.recordErr
}
func TestLandingService_ImportedRevisionRecovery(t *testing.T) {
	for _, tc := range []struct {
		name, requested, returnedChange string
		recordErr                       error
		status                          int
	}{
		{name: "current imported member", requested: "head", returnedChange: "member"},
		{name: "stale unrecorded revision", requested: "old", returnedChange: "member", status: 422},
		{name: "unrelated commit", requested: "foreign", returnedChange: "member", status: 422},
		{name: "repo host returned another change", requested: "head", returnedChange: "other", status: 422},
		{name: "revision write fails closed", requested: "head", returnedChange: "member", recordErr: fmt.Errorf("database unavailable"), status: 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &importedLandingRevisionQueries{importedRevisionLookup: &importedRevisionLookup{
				getLandingRevisionByCommitIDFn: func(_ context.Context, p db.GetLandingRequestChangeRevisionByCommitIDParams) (db.ChangeRevision, error) {
					require.Equal(t, int64(71), p.RepositoryID)
					require.Equal(t, int64(93), p.LandingRequestID)
					return db.ChangeRevision{}, pgx.ErrNoRows
				},
				listLandingRequestChangesFn: func(_ context.Context, p db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
					require.Equal(t, int64(93), p.LandingRequestID)
					return []db.LandingRequestChange{{LandingRequestID: 93, ChangeID: "member"}}, nil
				},
			}, recordErr: tc.recordErr}
			rh := &importedRevisionRepoHost{getChangeFn: func(_ context.Context, owner, repo, id string) (repohost.Change, error) {
				require.Equal(t, "owner", owner)
				require.Equal(t, "repository", repo)
				require.Equal(t, "member", id)
				return repohost.Change{ChangeID: tc.returnedChange, CommitID: "head", ParentCommitID: "parent"}, nil
			}}
			result, err := NewLandingService(q, rh).resolveLandingRevision(context.Background(), 71, "owner", "repository", 93, tc.requested, "LandingRequest")
			if tc.status == 0 {
				require.NoError(t, err)
				require.Equal(t, "head", result.CommitID)
				require.Equal(t, "member", result.ChangeID)
				require.Equal(t, "parent", result.ParentCommitID)
			} else {
				var apiErr *pkgerrors.APIError
				require.ErrorAs(t, err, &apiErr)
				require.Equal(t, tc.status, apiErr.Status)
			}
			if tc.status == 422 {
				require.Empty(t, q.changes)
				require.Empty(t, q.revisions)
			} else {
				require.Len(t, q.changes, 1)
				require.Len(t, q.revisions, 1)
				require.Equal(t, int64(71), q.revisions[0].RepositoryID)
				require.Equal(t, "push", q.revisions[0].Source)
				require.Empty(t, q.revisions[0].AgentSessionID)
			}
		})
	}
}
func TestLandingService_RecordedRevisionDoesNotResnapshotCurrentHead(t *testing.T) {
	q := &importedLandingRevisionQueries{importedRevisionLookup: &importedRevisionLookup{
		getLandingRevisionByCommitIDFn: func(_ context.Context, p db.GetLandingRequestChangeRevisionByCommitIDParams) (db.ChangeRevision, error) {
			return db.ChangeRevision{ChangeID: "member", CommitID: p.CommitID}, nil
		},
	}}
	rh := &importedRevisionRepoHost{getChangeFn: func(context.Context, string, string, string) (repohost.Change, error) {
		t.Fatal("recorded history must not be replaced with current head")
		return repohost.Change{}, nil
	}}
	revision, err := NewLandingService(q, rh).resolveLandingRevision(context.Background(), 71, "owner", "repository", 93, "recorded-old", "LandingReview")
	require.NoError(t, err)
	require.Equal(t, "recorded-old", revision.CommitID)
	require.Empty(t, q.changes)
	require.Empty(t, q.revisions)
}
