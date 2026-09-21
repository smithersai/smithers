package services

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestSearch_Cov_IssueAndUserErrorBranches(t *testing.T) {
	t.Run("issue query too long", func(t *testing.T) {
		_, err := NewSearchService(&mockSearchQuerier{}).SearchIssues(context.Background(), nil, SearchIssuesInput{Query: strings.Repeat("x", searchMaxQueryLen+1)})
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusBadRequest {
			t.Fatalf("err = %#v, want bad request", err)
		}
	})

	t.Run("issue search error", func(t *testing.T) {
		svc := NewSearchService(&mockSearchQuerier{
			countSearchIssuesFn: func(context.Context, db.CountSearchIssuesFTSParams) (int64, error) {
				return 1, nil
			},
			searchIssuesFTSFn: func(context.Context, db.SearchIssuesFTSParams) ([]db.SearchIssuesFTSRow, error) {
				return nil, errors.New("search failed")
			},
		})
		_, err := svc.SearchIssues(context.Background(), &db.User{ID: 3}, SearchIssuesInput{Query: "bug", State: "closed"})
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusInternalServerError {
			t.Fatalf("err = %#v, want internal", err)
		}
	})

	t.Run("users zero count and list error", func(t *testing.T) {
		mock := &mockSearchQuerier{
			countSearchUsersFn: func(context.Context, string) (int64, error) {
				return 0, nil
			},
			searchUsersFTSFn: func(context.Context, db.SearchUsersFTSParams) ([]db.SearchUsersFTSRow, error) {
				t.Fatal("search should not run with zero count")
				return nil, nil
			},
		}
		page, err := NewSearchService(mock).SearchUsers(context.Background(), SearchUsersInput{Query: "alice", Page: -1, PerPage: -1})
		if err != nil || len(page.Items) != 0 || page.Page != 1 || page.PerPage != searchDefaultPerPage {
			t.Fatalf("zero page = %+v, %v", page, err)
		}

		svc := NewSearchService(&mockSearchQuerier{
			countSearchUsersFn: func(context.Context, string) (int64, error) {
				return 1, nil
			},
			searchUsersFTSFn: func(context.Context, db.SearchUsersFTSParams) ([]db.SearchUsersFTSRow, error) {
				return nil, errors.New("search failed")
			},
		})
		_, err = svc.SearchUsers(context.Background(), SearchUsersInput{Query: "alice"})
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusInternalServerError {
			t.Fatalf("err = %#v, want internal", err)
		}
	})
}

func TestSearch_Cov_SearchUsersHappyPathAndViewerID(t *testing.T) {
	svc := NewSearchService(&mockSearchQuerier{
		countSearchUsersFn: func(_ context.Context, query string) (int64, error) {
			if query != "alice" {
				t.Fatalf("query = %q", query)
			}
			return 1, nil
		},
		searchUsersFTSFn: func(_ context.Context, arg db.SearchUsersFTSParams) ([]db.SearchUsersFTSRow, error) {
			if arg.PageOffset != 100 || arg.PageSize != 100 {
				t.Fatalf("pagination = %+v", arg)
			}
			return []db.SearchUsersFTSRow{{ID: 1, Username: "alice", DisplayName: "Alice", AvatarUrl: "https://avatar"}}, nil
		},
	})
	page, err := svc.SearchUsers(context.Background(), SearchUsersInput{Query: " alice ", Page: 2, PerPage: 500})
	if err != nil {
		t.Fatalf("SearchUsers returned error: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].Username != "alice" || searchViewerID(&db.User{ID: 7}) != 7 || searchViewerID(nil) != 0 {
		t.Fatalf("page = %+v", page)
	}
}
