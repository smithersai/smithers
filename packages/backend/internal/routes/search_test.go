package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockSearchRouteService struct {
	searchRepositoriesFn func(ctx context.Context, viewer *db.User, input services.SearchRepositoriesInput) (services.RepositorySearchResultPage, error)
	searchIssuesFn       func(ctx context.Context, viewer *db.User, input services.SearchIssuesInput) (services.IssueSearchResultPage, error)
	searchUsersFn        func(ctx context.Context, input services.SearchUsersInput) (services.UserSearchResultPage, error)
	searchCodeFn         func(ctx context.Context, viewer *db.User, input services.SearchCodeInput) (services.CodeSearchResultPage, error)
}

func (m mockSearchRouteService) SearchRepositories(ctx context.Context, viewer *db.User, input services.SearchRepositoriesInput) (services.RepositorySearchResultPage, error) {
	return m.searchRepositoriesFn(ctx, viewer, input)
}

func (m mockSearchRouteService) SearchIssues(ctx context.Context, viewer *db.User, input services.SearchIssuesInput) (services.IssueSearchResultPage, error) {
	return m.searchIssuesFn(ctx, viewer, input)
}

func (m mockSearchRouteService) SearchUsers(ctx context.Context, input services.SearchUsersInput) (services.UserSearchResultPage, error) {
	return m.searchUsersFn(ctx, input)
}

func (m mockSearchRouteService) SearchCode(ctx context.Context, viewer *db.User, input services.SearchCodeInput) (services.CodeSearchResultPage, error) {
	return m.searchCodeFn(ctx, viewer, input)
}

func TestSearchHandler_SearchRepositories(t *testing.T) {
	t.Parallel()

	h := &SearchHandler{
		Service: mockSearchRouteService{
			searchRepositoriesFn: func(ctx context.Context, viewer *db.User, input services.SearchRepositoriesInput) (services.RepositorySearchResultPage, error) {
				require.NotNil(t, viewer)
				assert.Equal(t, int64(9), viewer.ID)
				assert.Equal(t, "auth", input.Query)
				assert.Equal(t, 2, input.Page)
				assert.Equal(t, 10, input.PerPage)
				return services.RepositorySearchResultPage{
					Items: []services.RepositorySearchResult{
						{ID: 1, Owner: "alice", Name: "auth-core", FullName: "alice/auth-core"},
					},
					TotalCount: 25,
					Page:       2,
					PerPage:    10,
				}, nil
			},
		},
	}

	r := chi.NewRouter()
	r.Get("/api/search/repositories", h.SearchRepositories)

	req := httptest.NewRequest(http.MethodGet, "/api/search/repositories?q=auth&page=2&per_page=10", nil)
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 9, Username: "alice", LowerUsername: "alice"},
	}))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "25", rec.Header().Get("X-Total-Count"))
	assert.Contains(t, rec.Header().Get("Link"), `rel="next"`)

	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	items, ok := body["items"].([]any)
	require.True(t, ok)
	require.Len(t, items, 1)
	item, ok := items[0].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "auth-core", item["name"])
	assert.EqualValues(t, 25, body["total_count"])
}

func TestSearchHandler_SearchRepositories_QueryRequired422(t *testing.T) {
	t.Parallel()

	h := &SearchHandler{
		Service: mockSearchRouteService{
			searchRepositoriesFn: func(ctx context.Context, viewer *db.User, input services.SearchRepositoriesInput) (services.RepositorySearchResultPage, error) {
				return services.RepositorySearchResultPage{}, &pkgerrors.APIError{Status: 422, Message: "query required"}
			},
			searchIssuesFn: func(ctx context.Context, viewer *db.User, input services.SearchIssuesInput) (services.IssueSearchResultPage, error) {
				t.Fatal("unexpected issues call")
				return services.IssueSearchResultPage{}, nil
			},
			searchUsersFn: func(ctx context.Context, input services.SearchUsersInput) (services.UserSearchResultPage, error) {
				t.Fatal("unexpected users call")
				return services.UserSearchResultPage{}, nil
			},
			searchCodeFn: func(ctx context.Context, viewer *db.User, input services.SearchCodeInput) (services.CodeSearchResultPage, error) {
				t.Fatal("unexpected code call")
				return services.CodeSearchResultPage{}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/search/repositories?q=", nil)
	rec := httptest.NewRecorder()
	h.SearchRepositories(rec, req)

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "query required", payload["message"])
}

func TestSearchHandler_SearchIssues_WithAllFilters(t *testing.T) {
	t.Parallel()

	h := &SearchHandler{
		Service: mockSearchRouteService{
			searchRepositoriesFn: func(ctx context.Context, viewer *db.User, input services.SearchRepositoriesInput) (services.RepositorySearchResultPage, error) {
				t.Fatal("unexpected repository search")
				return services.RepositorySearchResultPage{}, nil
			},
			searchIssuesFn: func(ctx context.Context, viewer *db.User, input services.SearchIssuesInput) (services.IssueSearchResultPage, error) {
				assert.Equal(t, "bug", input.Query)
				assert.Equal(t, "open", input.State)
				assert.Equal(t, "bug", input.Label)
				assert.Equal(t, "alice", input.Assignee)
				assert.Equal(t, "v1.0", input.Milestone)
				return services.IssueSearchResultPage{
					Items: []services.IssueSearchResult{
						{ID: 7, RepositoryName: "core", Number: 12, Title: "bug in auth", State: "open"},
					},
					TotalCount: 1,
					Page:       1,
					PerPage:    30,
				}, nil
			},
			searchUsersFn: func(ctx context.Context, input services.SearchUsersInput) (services.UserSearchResultPage, error) {
				t.Fatal("unexpected user search")
				return services.UserSearchResultPage{}, nil
			},
			searchCodeFn: func(ctx context.Context, viewer *db.User, input services.SearchCodeInput) (services.CodeSearchResultPage, error) {
				t.Fatal("unexpected code search")
				return services.CodeSearchResultPage{}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/search/issues?q=bug&state=open&label=bug&assignee=alice&milestone=v1.0", nil)
	rec := httptest.NewRecorder()
	h.SearchIssues(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "1", rec.Header().Get("X-Total-Count"))
}

func TestSearchHandler_SearchUsers(t *testing.T) {
	t.Parallel()

	h := &SearchHandler{
		Service: mockSearchRouteService{
			searchRepositoriesFn: func(ctx context.Context, viewer *db.User, input services.SearchRepositoriesInput) (services.RepositorySearchResultPage, error) {
				t.Fatal("unexpected repository search")
				return services.RepositorySearchResultPage{}, nil
			},
			searchIssuesFn: func(ctx context.Context, viewer *db.User, input services.SearchIssuesInput) (services.IssueSearchResultPage, error) {
				t.Fatal("unexpected issue search")
				return services.IssueSearchResultPage{}, nil
			},
			searchUsersFn: func(ctx context.Context, input services.SearchUsersInput) (services.UserSearchResultPage, error) {
				assert.Equal(t, "alice", input.Query)
				return services.UserSearchResultPage{
					Items:      []services.UserSearchResult{{ID: 1, Username: "alice", DisplayName: "Alice"}},
					TotalCount: 1,
					Page:       1,
					PerPage:    30,
				}, nil
			},
			searchCodeFn: func(ctx context.Context, viewer *db.User, input services.SearchCodeInput) (services.CodeSearchResultPage, error) {
				t.Fatal("unexpected code search")
				return services.CodeSearchResultPage{}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	rec := httptest.NewRecorder()
	h.SearchUsers(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "1", rec.Header().Get("X-Total-Count"))
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	items, ok := body["items"].([]any)
	require.True(t, ok)
	require.Len(t, items, 1)
	item, ok := items[0].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "alice", item["username"])
}

func TestSearchHandler_SearchCode(t *testing.T) {
	t.Parallel()

	h := &SearchHandler{
		Service: mockSearchRouteService{
			searchRepositoriesFn: func(ctx context.Context, viewer *db.User, input services.SearchRepositoriesInput) (services.RepositorySearchResultPage, error) {
				t.Fatal("unexpected repository search")
				return services.RepositorySearchResultPage{}, nil
			},
			searchIssuesFn: func(ctx context.Context, viewer *db.User, input services.SearchIssuesInput) (services.IssueSearchResultPage, error) {
				t.Fatal("unexpected issue search")
				return services.IssueSearchResultPage{}, nil
			},
			searchUsersFn: func(ctx context.Context, input services.SearchUsersInput) (services.UserSearchResultPage, error) {
				t.Fatal("unexpected user search")
				return services.UserSearchResultPage{}, nil
			},
			searchCodeFn: func(ctx context.Context, viewer *db.User, input services.SearchCodeInput) (services.CodeSearchResultPage, error) {
				assert.Nil(t, viewer)
				assert.Equal(t, "hello", input.Query)
				return services.CodeSearchResultPage{
					Items: []services.CodeSearchResult{
						{
							RepositoryID:    9,
							RepositoryOwner: "alice",
							RepositoryName:  "demo",
							Path:            "README.md",
						},
					},
					TotalCount: 1,
					Page:       1,
					PerPage:    30,
				}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/search/code?q=hello", nil)
	rec := httptest.NewRecorder()
	h.SearchCode(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "1", rec.Header().Get("X-Total-Count"))

	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.EqualValues(t, 1, body["total_count"])
	items, ok := body["items"].([]any)
	require.True(t, ok)
	require.Len(t, items, 1)
	item, ok := items[0].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "README.md", item["path"])
}

func TestSearchHandler_InvalidPaginationReturns400(t *testing.T) {
	t.Parallel()

	h := &SearchHandler{
		Service: mockSearchRouteService{
			searchRepositoriesFn: func(ctx context.Context, viewer *db.User, input services.SearchRepositoriesInput) (services.RepositorySearchResultPage, error) {
				t.Fatal("service should not be called")
				return services.RepositorySearchResultPage{}, nil
			},
			searchIssuesFn: func(ctx context.Context, viewer *db.User, input services.SearchIssuesInput) (services.IssueSearchResultPage, error) {
				t.Fatal("service should not be called")
				return services.IssueSearchResultPage{}, nil
			},
			searchUsersFn: func(ctx context.Context, input services.SearchUsersInput) (services.UserSearchResultPage, error) {
				t.Fatal("service should not be called")
				return services.UserSearchResultPage{}, nil
			},
			searchCodeFn: func(ctx context.Context, viewer *db.User, input services.SearchCodeInput) (services.CodeSearchResultPage, error) {
				t.Fatal("service should not be called")
				return services.CodeSearchResultPage{}, nil
			},
		},
	}

	cases := []string{
		"/api/search/repositories?q=auth&page=0",
		"/api/search/repositories?q=auth&per_page=0",
		"/api/search/repositories?q=auth&page=abc",
	}

	for _, path := range cases {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		h.SearchRepositories(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	}
}
