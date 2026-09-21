package services

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// mockEventQuerier satisfies IssueEventQuerier for unit testing.
type mockEventQuerier struct {
	getRepoFn          func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	isOrgOwnerFn       func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	highestTeamPermFn  func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	collabPermFn       func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	getIssueByNumberFn func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error)
	listIssueEventsFn  func(ctx context.Context, arg db.ListIssueEventsByIssueParams) ([]db.IssueEvent, error)
	getUserByIDFn      func(ctx context.Context, id int64) (db.User, error)
}

func (m *mockEventQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if m.getRepoFn != nil {
		return m.getRepoFn(ctx, arg)
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (m *mockEventQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerFn != nil {
		return m.isOrgOwnerFn(ctx, arg)
	}
	return false, nil
}

func (m *mockEventQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.highestTeamPermFn != nil {
		return m.highestTeamPermFn(ctx, arg)
	}
	return "", nil
}

func (m *mockEventQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.collabPermFn != nil {
		return m.collabPermFn(ctx, arg)
	}
	return "", nil
}

func (m *mockEventQuerier) GetIssueByNumber(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
	if m.getIssueByNumberFn != nil {
		return m.getIssueByNumberFn(ctx, arg)
	}
	return db.Issue{}, pgx.ErrNoRows
}

func (m *mockEventQuerier) ListIssueEventsByIssue(ctx context.Context, arg db.ListIssueEventsByIssueParams) ([]db.IssueEvent, error) {
	if m.listIssueEventsFn != nil {
		return m.listIssueEventsFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockEventQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if m.getUserByIDFn != nil {
		return m.getUserByIDFn(ctx, id)
	}
	return db.User{ID: id}, nil
}

func TestIssueEventService_ListIssueEvents_PrivateRepoForbiddenForNil(t *testing.T) {
	q := &mockEventQuerier{
		getRepoFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 1, IsPublic: false, UserID: pgtype.Int8{Int64: 99, Valid: true}}, nil
		},
	}
	svc := NewIssueEventService(q)
	_, err := svc.ListIssueEvents(context.Background(), nil, "owner", "repo", 1, 1, 30)
	require.Error(t, err)
	assert.Equal(t, http.StatusForbidden, err.(*pkgerrors.APIError).Status)
}

func TestIssueEventService_ListIssueEvents_PublicRepo_ReturnsEvents(t *testing.T) {
	payload, _ := json.Marshal(map[string]string{"type": "state_changed"})
	now := time.Now()
	q := &mockEventQuerier{
		getRepoFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 10, IsPublic: true}, nil
		},
		getIssueByNumberFn: func(_ context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
			return db.Issue{ID: 100, RepositoryID: 10, Number: arg.Number}, nil
		},
		listIssueEventsFn: func(_ context.Context, arg db.ListIssueEventsByIssueParams) ([]db.IssueEvent, error) {
			assert.Equal(t, int64(100), arg.IssueID)
			assert.Equal(t, int32(0), arg.PageOffset) // page 1 → offset 0
			assert.Equal(t, int32(10), arg.PageSize)
			return []db.IssueEvent{
				{ID: 1, IssueID: 100, EventType: "state_changed", Payload: payload, CreatedAt: now},
			}, nil
		},
	}
	svc := NewIssueEventService(q)
	items, err := svc.ListIssueEvents(context.Background(), nil, "owner", "repo", 1, 1, 10)
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, int64(1), items[0].ID)
	assert.Equal(t, "state_changed", items[0].EventType)
	assert.Nil(t, items[0].ActorID)
}

func TestIssueEventService_ListIssueEvents_ActorIDPopulated(t *testing.T) {
	payload, _ := json.Marshal(map[string]string{})
	q := &mockEventQuerier{
		getRepoFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 10, IsPublic: true}, nil
		},
		getIssueByNumberFn: func(_ context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
			return db.Issue{ID: 100, RepositoryID: 10, Number: arg.Number}, nil
		},
		listIssueEventsFn: func(_ context.Context, _ db.ListIssueEventsByIssueParams) ([]db.IssueEvent, error) {
			return []db.IssueEvent{
				{
					ID:        2,
					IssueID:   100,
					ActorID:   pgtype.Int8{Int64: 42, Valid: true},
					EventType: "assigned",
					Payload:   payload,
					CreatedAt: time.Now(),
				},
			}, nil
		},
	}
	svc := NewIssueEventService(q)
	items, err := svc.ListIssueEvents(context.Background(), nil, "owner", "repo", 1, 1, 30)
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, int64(42), items[0].ActorID)
}

func TestIssueEventService_ListIssueEvents_RepoNotFound(t *testing.T) {
	svc := NewIssueEventService(&mockEventQuerier{})
	_, err := svc.ListIssueEvents(context.Background(), nil, "owner", "repo", 1, 1, 30)
	require.Error(t, err)
	assert.Equal(t, http.StatusNotFound, err.(*pkgerrors.APIError).Status)
}
