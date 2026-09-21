package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestSearchHandler_SearchUsers_Success(t *testing.T) {
	t.Parallel()

	h := &SearchHandler{Service: mockSearchRouteService{
		searchRepositoriesFn: func(ctx context.Context, viewer *db.User, input services.SearchRepositoriesInput) (services.RepositorySearchResultPage, error) {
			return services.RepositorySearchResultPage{}, nil
		},
		searchIssuesFn: func(ctx context.Context, viewer *db.User, input services.SearchIssuesInput) (services.IssueSearchResultPage, error) {
			return services.IssueSearchResultPage{}, nil
		},
		searchUsersFn: func(ctx context.Context, input services.SearchUsersInput) (services.UserSearchResultPage, error) {
			assert.Equal(t, "alice", input.Query)
			return services.UserSearchResultPage{
				TotalCount: 1,
				Items:      []services.UserSearchResult{{ID: 1, Username: "alice"}},
			}, nil
		},
		searchCodeFn: func(ctx context.Context, viewer *db.User, input services.SearchCodeInput) (services.CodeSearchResultPage, error) {
			return services.CodeSearchResultPage{}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	rec := httptest.NewRecorder()
	h.SearchUsers(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var result services.UserSearchResultPage
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
	assert.Equal(t, int64(1), result.TotalCount)
	assert.Len(t, result.Items, 1)
}

func TestSearchHandler_SearchRepositories_ServiceError(t *testing.T) {
	t.Parallel()

	h := &SearchHandler{Service: mockSearchRouteService{
		searchRepositoriesFn: func(ctx context.Context, viewer *db.User, input services.SearchRepositoriesInput) (services.RepositorySearchResultPage, error) {
			return services.RepositorySearchResultPage{}, pkgerrors.Internal("search unavailable")
		},
		searchIssuesFn: func(ctx context.Context, viewer *db.User, input services.SearchIssuesInput) (services.IssueSearchResultPage, error) {
			return services.IssueSearchResultPage{}, nil
		},
		searchUsersFn: func(ctx context.Context, input services.SearchUsersInput) (services.UserSearchResultPage, error) {
			return services.UserSearchResultPage{}, nil
		},
		searchCodeFn: func(ctx context.Context, viewer *db.User, input services.SearchCodeInput) (services.CodeSearchResultPage, error) {
			return services.CodeSearchResultPage{}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/search/repos?q=test", nil)
	rec := httptest.NewRecorder()
	h.SearchRepositories(rec, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestSearchHandler_SearchCode_EmptyQuery(t *testing.T) {
	t.Parallel()

	h := &SearchHandler{Service: mockSearchRouteService{
		searchRepositoriesFn: func(ctx context.Context, viewer *db.User, input services.SearchRepositoriesInput) (services.RepositorySearchResultPage, error) {
			return services.RepositorySearchResultPage{}, nil
		},
		searchIssuesFn: func(ctx context.Context, viewer *db.User, input services.SearchIssuesInput) (services.IssueSearchResultPage, error) {
			return services.IssueSearchResultPage{}, nil
		},
		searchUsersFn: func(ctx context.Context, input services.SearchUsersInput) (services.UserSearchResultPage, error) {
			return services.UserSearchResultPage{}, nil
		},
		searchCodeFn: func(ctx context.Context, viewer *db.User, input services.SearchCodeInput) (services.CodeSearchResultPage, error) {
			assert.Equal(t, "", input.Query)
			return services.CodeSearchResultPage{TotalCount: 0, Items: nil}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/search/code", nil)
	rec := httptest.NewRecorder()
	h.SearchCode(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestParseSearchPagination_DefaultValues(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/api/search?q=test", nil)
	cursor, limit, err := parseSearchPagination(req)
	require.NoError(t, err)
	assert.Equal(t, "", cursor)
	assert.Equal(t, 30, limit)
}

func TestParseSearchPagination_CustomLimit(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/api/search?q=test&limit=50", nil)
	cursor, limit, err := parseSearchPagination(req)
	require.NoError(t, err)
	assert.Equal(t, "", cursor)
	assert.Equal(t, 50, limit)
}

func TestParseSearchPagination_LimitCappedAt100(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/api/search?q=test&limit=999", nil)
	_, limit, err := parseSearchPagination(req)
	require.NoError(t, err)
	assert.Equal(t, 100, limit)
}

func TestParseSearchPagination_InvalidLimit(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/api/search?q=test&limit=bad", nil)
	_, _, err := parseSearchPagination(req)
	require.Error(t, err)
}
