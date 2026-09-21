package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type issueEventsZQuerier struct {
	repoFn       func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	orgOwnerFn   func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error)
	teamPermFn   func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	collabPermFn func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	issueFn      func(context.Context, db.GetIssueByNumberParams) (db.Issue, error)
	eventsFn     func(context.Context, db.ListIssueEventsByIssueParams) ([]db.IssueEvent, error)
}

func (q issueEventsZQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if q.repoFn != nil {
		return q.repoFn(ctx, arg)
	}
	return db.Repository{ID: 11, IsPublic: true}, nil
}
func (q issueEventsZQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if q.orgOwnerFn != nil {
		return q.orgOwnerFn(ctx, arg)
	}
	return false, nil
}
func (q issueEventsZQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if q.teamPermFn != nil {
		return q.teamPermFn(ctx, arg)
	}
	return "", nil
}
func (q issueEventsZQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if q.collabPermFn != nil {
		return q.collabPermFn(ctx, arg)
	}
	return "", nil
}
func (q issueEventsZQuerier) GetIssueByNumber(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
	if q.issueFn != nil {
		return q.issueFn(ctx, arg)
	}
	return db.Issue{ID: 22, RepositoryID: arg.RepositoryID, Number: arg.Number}, nil
}
func (q issueEventsZQuerier) ListIssueEventsByIssue(ctx context.Context, arg db.ListIssueEventsByIssueParams) ([]db.IssueEvent, error) {
	if q.eventsFn != nil {
		return q.eventsFn(ctx, arg)
	}
	return nil, nil
}
func (q issueEventsZQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	return db.User{ID: id}, nil
}

func TestIssueEvents_Z_ErrorBranches(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 7}

	_, err := NewIssueEventService(issueEventsZQuerier{
		eventsFn: func(context.Context, db.ListIssueEventsByIssueParams) ([]db.IssueEvent, error) {
			return nil, errors.New("events failed")
		},
	}).ListIssueEvents(ctx, actor, "alice", "demo", 1, 0, 0)
	require.Equal(t, 500, apiStatus(t, err))

	svc := NewIssueEventService(issueEventsZQuerier{})
	_, err = svc.resolveRepo(ctx, "", "demo")
	require.Equal(t, 400, apiStatus(t, err))
	_, err = svc.resolveRepo(ctx, "alice", "")
	require.Equal(t, 400, apiStatus(t, err))

	_, err = NewIssueEventService(issueEventsZQuerier{
		repoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, errors.New("repo failed")
		},
	}).resolveRepo(ctx, "alice", "demo")
	require.Equal(t, 500, apiStatus(t, err))

	err = NewIssueEventService(issueEventsZQuerier{}).requireRead(ctx, db.Repository{ID: 12, UserID: pgtype.Int8{Int64: 99, Valid: true}}, actor)
	require.Equal(t, 403, apiStatus(t, err))

	err = NewIssueEventService(issueEventsZQuerier{
		teamPermFn: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "", errors.New("permission failed")
		},
	}).requireRead(ctx, db.Repository{ID: 12, OrgID: pgtype.Int8{Int64: 1, Valid: true}}, actor)
	require.Equal(t, 500, apiStatus(t, err))

	_, err = NewIssueEventService(issueEventsZQuerier{
		issueFn: func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) {
			return db.Issue{}, pgx.ErrNoRows
		},
	}).getIssueByNumber(ctx, 11, 1)
	require.Equal(t, 404, apiStatus(t, err))

	_, err = NewIssueEventService(issueEventsZQuerier{
		issueFn: func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) {
			return db.Issue{}, errors.New("issue failed")
		},
	}).getIssueByNumber(ctx, 11, 1)
	require.Equal(t, 500, apiStatus(t, err))
}
