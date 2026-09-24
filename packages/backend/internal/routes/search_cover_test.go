package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type searchCovService struct {
	reposFn  func(context.Context, *db.User, services.SearchRepositoriesInput) (services.RepositorySearchResultPage, error)
	issuesFn func(context.Context, *db.User, services.SearchIssuesInput) (services.IssueSearchResultPage, error)
	usersFn  func(context.Context, services.SearchUsersInput) (services.UserSearchResultPage, error)
	codeFn   func(context.Context, *db.User, services.SearchCodeInput) (services.CodeSearchResultPage, error)
}

func (s searchCovService) SearchRepositories(ctx context.Context, viewer *db.User, input services.SearchRepositoriesInput) (services.RepositorySearchResultPage, error) {
	if s.reposFn != nil {
		return s.reposFn(ctx, viewer, input)
	}
	return services.RepositorySearchResultPage{}, nil
}

func (s searchCovService) SearchIssues(ctx context.Context, viewer *db.User, input services.SearchIssuesInput) (services.IssueSearchResultPage, error) {
	if s.issuesFn != nil {
		return s.issuesFn(ctx, viewer, input)
	}
	return services.IssueSearchResultPage{}, nil
}

func (s searchCovService) SearchUsers(ctx context.Context, input services.SearchUsersInput) (services.UserSearchResultPage, error) {
	if s.usersFn != nil {
		return s.usersFn(ctx, input)
	}
	return services.UserSearchResultPage{}, nil
}

func (s searchCovService) SearchCode(ctx context.Context, viewer *db.User, input services.SearchCodeInput) (services.CodeSearchResultPage, error) {
	if s.codeFn != nil {
		return s.codeFn(ctx, viewer, input)
	}
	return services.CodeSearchResultPage{}, nil
}

func TestSearch_Cov_IssuesUsersCodeBranches(t *testing.T) {
	t.Parallel()

	t.Run("issues trims filters and paginates", func(t *testing.T) {
		t.Parallel()

		h := &SearchHandler{Service: searchCovService{
			issuesFn: func(_ context.Context, viewer *db.User, input services.SearchIssuesInput) (services.IssueSearchResultPage, error) {
				require.NotNil(t, viewer)
				assert.Equal(t, int64(7), viewer.ID)
				assert.Equal(t, "bug", input.Query)
				assert.Equal(t, "open", input.State)
				assert.Equal(t, "bug", input.Label)
				assert.Equal(t, "alice", input.Assignee)
				assert.Equal(t, "v1", input.Milestone)
				assert.Equal(t, 3, input.Page)
				assert.Equal(t, 10, input.PerPage)
				return services.IssueSearchResultPage{Items: []services.IssueSearchResult{{ID: 1, Title: "bug"}}, TotalCount: 21}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/search/issues?q=bug&state=%20open%20&label=%20bug%20&assignee=%20alice%20&milestone=%20v1%20&page=3&per_page=10", nil)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.SearchIssues(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "21", rec.Header().Get("X-Total-Count"))
	})

	t.Run("issues service error", func(t *testing.T) {
		t.Parallel()

		h := &SearchHandler{Service: searchCovService{
			issuesFn: func(context.Context, *db.User, services.SearchIssuesInput) (services.IssueSearchResultPage, error) {
				return services.IssueSearchResultPage{}, pkgerrors.Internal("search unavailable")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/search/issues?q=bug", nil)
		rec := httptest.NewRecorder()

		h.SearchIssues(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("users pagination error", func(t *testing.T) {
		t.Parallel()

		h := &SearchHandler{Service: searchCovService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/search/users?limit=0", nil)
		rec := httptest.NewRecorder()

		h.SearchUsers(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("code service error", func(t *testing.T) {
		t.Parallel()

		h := &SearchHandler{Service: searchCovService{
			codeFn: func(context.Context, *db.User, services.SearchCodeInput) (services.CodeSearchResultPage, error) {
				return services.CodeSearchResultPage{}, pkgerrors.Forbidden("permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/search/code?q=secret", nil)
		rec := httptest.NewRecorder()

		h.SearchCode(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})
}
