package services

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestIssueEvents_Cov_PrivateRepoCollaboratorCanReadAndPaginationDefaults(t *testing.T) {
	var listArg db.ListIssueEventsByIssueParams
	q := &mockEventQuerier{
		getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 11, IsPublic: false, UserID: pgtype.Int8{Int64: 99, Valid: true}}, nil
		},
		collabPermFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "read", nil
		},
		getIssueByNumberFn: func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) {
			return db.Issue{ID: 22, RepositoryID: 11, Number: 3}, nil
		},
		listIssueEventsFn: func(_ context.Context, arg db.ListIssueEventsByIssueParams) ([]db.IssueEvent, error) {
			listArg = arg
			return []db.IssueEvent{{ID: 33, IssueID: 22, EventType: "closed"}}, nil
		},
	}

	items, err := NewIssueEventService(q).ListIssueEvents(context.Background(), &db.User{ID: 42}, " Alice ", " Demo ", 3, 0, 0)
	if err != nil {
		t.Fatalf("ListIssueEvents returned error: %v", err)
	}
	if len(items) != 1 || items[0].ID != 33 {
		t.Fatalf("items = %+v", items)
	}
	if listArg.PageOffset != 0 || listArg.PageSize != 30 {
		t.Fatalf("pagination arg = %+v, want default page size 30 offset 0", listArg)
	}
}

func TestIssueEvents_Cov_ErrorBranches(t *testing.T) {
	t.Run("blank owner", func(t *testing.T) {
		_, err := NewIssueEventService(&mockEventQuerier{}).ListIssueEvents(context.Background(), nil, " ", "repo", 1, 1, 1)
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusBadRequest {
			t.Fatalf("err = %#v, want bad request", err)
		}
	})

	t.Run("private repo permission lookup error", func(t *testing.T) {
		q := &mockEventQuerier{
			getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 1, IsPublic: false, OrgID: pgtype.Int8{Int64: 7, Valid: true}}, nil
			},
			isOrgOwnerFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
				return false, errors.New("db down")
			},
		}
		_, err := NewIssueEventService(q).ListIssueEvents(context.Background(), &db.User{ID: 2}, "alice", "repo", 1, 1, 1)
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusInternalServerError {
			t.Fatalf("err = %#v, want internal", err)
		}
	})

	t.Run("invalid issue number", func(t *testing.T) {
		q := &mockEventQuerier{
			getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 1, IsPublic: true}, nil
			},
		}
		_, err := NewIssueEventService(q).ListIssueEvents(context.Background(), nil, "alice", "repo", 0, 1, 1)
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusBadRequest {
			t.Fatalf("err = %#v, want bad request", err)
		}
	})

	t.Run("issue query no rows", func(t *testing.T) {
		q := &mockEventQuerier{
			getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 1, IsPublic: true}, nil
			},
			getIssueByNumberFn: func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) {
				return db.Issue{}, pgx.ErrNoRows
			},
		}
		_, err := NewIssueEventService(q).ListIssueEvents(context.Background(), nil, "alice", "repo", 9, 1, 1)
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusNotFound {
			t.Fatalf("err = %#v, want not found", err)
		}
	})
}
