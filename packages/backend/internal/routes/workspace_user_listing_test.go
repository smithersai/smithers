package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// Ticket 0135 route tests for GET /api/user/workspaces and
// GET /api/user/readable-repos. These cover:
//   - auth requirement (401 without user),
//   - pagination-cap behavior,
//   - that the DTO fields land in the response body,
//   - that a "row whose repo access has been revoked" is already hidden by
//     the service (represented here as a service-layer filtered result).

func TestGetUserWorkspaces_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/user/workspaces", nil)
	rec := httptest.NewRecorder()
	h.GetUserWorkspaces(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestGetUserWorkspaces_ReturnsRows(t *testing.T) {
	t.Parallel()

	now := time.Now()
	suspendedAt := now.Add(-2 * time.Hour)
	startedAt := now.Add(-time.Hour)
	svc := &mockWorkspaceRouteService{
		listUserWorkspacesFn: func(ctx context.Context, userID int64, page, perPage int) (services.UserWorkspaceListResult, error) {
			assert.Equal(t, int64(42), userID)
			return services.UserWorkspaceListResult{
				Items: []services.UserWorkspaceRow{
					{
						WorkspaceID:       "ws-1",
						RepositoryID:      1,
						RepositoryOwner:   "alice",
						RepositoryName:    "demo",
						WorkspaceTitle:    "my-branch",
						State:             "failed",
						FailureCode:       "egress_proxy_unavailable",
						FailureMessage:    "workspace egress proxy is unavailable",
						TargetBookmark:    "main",
						ProvisioningStage: "ready",
						SuspendedAt:       &suspendedAt,
						Kind:              "vm",
						Head:              services.WorkspaceHead{ChangeID: "change-1", CommitID: "commit-1"},
						Ahead:             3,
						Behind:            1,
						StartedAt:         &startedAt,
						CreatedAt:         now,
						SortTimestamp:     now,
					},
				},
				TotalCount: 1,
				Page:       page,
				PerPage:    perPage,
			}, nil
		},
	}
	h := &WorkspaceHandler{Service: svc}

	req := httptest.NewRequest(http.MethodGet, "/api/user/workspaces?limit=10", nil)
	req = withAuth(req, 42, "user42")
	rec := httptest.NewRecorder()
	h.GetUserWorkspaces(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var body []map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body, 1)
	assert.Equal(t, "ws-1", body[0]["workspace_id"])
	assert.Equal(t, "alice", body[0]["repository_owner"])
	assert.Equal(t, "demo", body[0]["repository_name"])
	assert.Equal(t, "my-branch", body[0]["workspace_title"])
	assert.Equal(t, "failed", body[0]["state"])
	assert.Equal(t, "egress_proxy_unavailable", body[0]["failure_code"])
	assert.Equal(t, "workspace egress proxy is unavailable", body[0]["failure_message"])
	assert.Equal(t, "main", body[0]["target_bookmark"])
	assert.Equal(t, "ready", body[0]["provisioning_stage"])
	assert.Equal(t, "vm", body[0]["kind"])
	assert.Equal(t, float64(3), body[0]["ahead"])
	assert.Equal(t, float64(1), body[0]["behind"])
	assert.Equal(t, map[string]any{"change_id": "change-1", "commit_id": "commit-1"}, body[0]["head"])
	assert.NotNil(t, body[0]["suspended_at"])
	assert.NotNil(t, body[0]["started_at"])
}

func TestGetUserWorkspaces_SetsPaginationHeaders(t *testing.T) {
	t.Parallel()

	svc := &mockWorkspaceRouteService{
		listUserWorkspacesFn: func(ctx context.Context, userID int64, page, perPage int) (services.UserWorkspaceListResult, error) {
			return services.UserWorkspaceListResult{
				Items: []services.UserWorkspaceRow{
					{WorkspaceID: "ws-2"},
					{WorkspaceID: "ws-1"},
				},
				TotalCount: 5,
				Page:       page,
				PerPage:    perPage,
			}, nil
		},
	}
	h := &WorkspaceHandler{Service: svc}

	req := httptest.NewRequest(http.MethodGet, "/api/user/workspaces?limit=2", nil)
	req = withAuth(req, 42, "user42")
	rec := httptest.NewRecorder()
	h.GetUserWorkspaces(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "5", rec.Header().Get("X-Total-Count"))
	assert.Contains(t, rec.Header().Get("Link"), `rel="next"`)
	assert.Contains(t, rec.Header().Get("Link"), "cursor=2")
	assert.Contains(t, rec.Header().Get("Link"), "limit=2")
	assert.NotContains(t, rec.Header().Get("Link"), "page=")
	assert.NotContains(t, rec.Header().Get("Link"), "per_page=")

	nextReq := httptest.NewRequest(http.MethodGet, "/api/user/workspaces?cursor=2&limit=2", nil)
	nextReq = withAuth(nextReq, 42, "user42")
	nextRec := httptest.NewRecorder()
	h.GetUserWorkspaces(nextRec, nextReq)

	require.Equal(t, http.StatusOK, nextRec.Code)
	assert.Contains(t, nextRec.Header().Get("Link"), "cursor=4")
	assert.Contains(t, nextRec.Header().Get("Link"), `rel="next"`)
	assert.Contains(t, nextRec.Header().Get("Link"), `rel="prev"`)
	assert.NotContains(t, nextRec.Header().Get("Link"), "page=")
	assert.NotContains(t, nextRec.Header().Get("Link"), "per_page=")
}

func TestGetUserWorkspaces_FollowsCursorLinksAcrossThreePages(t *testing.T) {
	t.Parallel()

	allItems := []services.UserWorkspaceRow{
		{WorkspaceID: "ws-5"},
		{WorkspaceID: "ws-4"},
		{WorkspaceID: "ws-3"},
		{WorkspaceID: "ws-2"},
		{WorkspaceID: "ws-1"},
	}
	var calledPages []int
	svc := &mockWorkspaceRouteService{
		listUserWorkspacesFn: func(_ context.Context, _ int64, page, perPage int) (services.UserWorkspaceListResult, error) {
			calledPages = append(calledPages, page)
			start := (page - 1) * perPage
			end := min(start+perPage, len(allItems))
			return services.UserWorkspaceListResult{
				Items:      allItems[start:end],
				TotalCount: int64(len(allItems)),
				Page:       page,
				PerPage:    perPage,
			}, nil
		},
	}
	h := &WorkspaceHandler{Service: svc}

	path := "/api/user/workspaces?limit=2"
	var seen []string
	for page := 1; page <= 3; page++ {
		req := withAuth(httptest.NewRequest(http.MethodGet, path, nil), 42, "user42")
		rec := httptest.NewRecorder()
		h.GetUserWorkspaces(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var items []services.UserWorkspaceRow
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &items))
		for _, item := range items {
			seen = append(seen, item.WorkspaceID)
		}

		nextURL := ""
		for _, entry := range splitLinkHeader(rec.Header().Get("Link")) {
			if containsRelNext(entry) {
				nextURL = extractLinkURL(entry)
				break
			}
		}
		if page < 3 {
			require.NotEmpty(t, nextURL, "page %d must advertise the next cursor", page)
			assert.Contains(t, nextURL, "cursor=")
			assert.Contains(t, nextURL, "limit=2")
			assert.NotContains(t, nextURL, "page=")
			assert.NotContains(t, nextURL, "per_page=")
			path = nextURL
		} else {
			assert.Empty(t, nextURL, "final page must not advertise another page")
		}
	}

	assert.Equal(t, []int{1, 2, 3}, calledPages)
	assert.Equal(t, []string{"ws-5", "ws-4", "ws-3", "ws-2", "ws-1"}, seen)
}

func TestGetUserWorkspaces_PreservesFallbackAndTieBreakOrder(t *testing.T) {
	t.Parallel()

	newer := time.Date(2026, 4, 24, 14, 0, 0, 0, time.UTC)
	older := newer.Add(-time.Hour)
	svc := &mockWorkspaceRouteService{
		listUserWorkspacesFn: func(ctx context.Context, userID int64, page, perPage int) (services.UserWorkspaceListResult, error) {
			return services.UserWorkspaceListResult{
				Items: []services.UserWorkspaceRow{
					{
						WorkspaceID:     "ws-3",
						RepositoryID:    3,
						RepositoryOwner: "alice",
						RepositoryName:  "repo-c",
						WorkspaceTitle:  "repo-c",
						State:           "running",
						CreatedAt:       older,
						SortTimestamp:   newer,
					},
					{
						WorkspaceID:     "ws-2",
						RepositoryID:    2,
						RepositoryOwner: "alice",
						RepositoryName:  "repo-b",
						WorkspaceTitle:  "repo-b",
						State:           "running",
						CreatedAt:       older,
						SortTimestamp:   older,
					},
					{
						WorkspaceID:     "ws-1",
						RepositoryID:    1,
						RepositoryOwner: "alice",
						RepositoryName:  "repo-a",
						WorkspaceTitle:  "repo-a",
						State:           "running",
						CreatedAt:       older,
						SortTimestamp:   older,
					},
				},
				TotalCount: 3,
				Page:       page,
				PerPage:    perPage,
			}, nil
		},
	}
	h := &WorkspaceHandler{Service: svc}

	req := httptest.NewRequest(http.MethodGet, "/api/user/workspaces?limit=3", nil)
	req = withAuth(req, 42, "user42")
	rec := httptest.NewRecorder()
	h.GetUserWorkspaces(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var body []services.UserWorkspaceRow
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body, 3)
	assert.Equal(t, "ws-3", body[0].WorkspaceID)
	assert.Equal(t, "ws-2", body[1].WorkspaceID)
	assert.Equal(t, "ws-1", body[2].WorkspaceID)
	assert.True(t, body[0].SortTimestamp.After(body[1].SortTimestamp))
	assert.Equal(t, body[1].SortTimestamp, body[2].SortTimestamp)
	assert.Nil(t, body[0].LastAccessedAt)
	assert.Nil(t, body[1].LastAccessedAt)
	assert.Nil(t, body[2].LastAccessedAt)
}

func TestGetUserWorkspaces_LimitCappedAt100(t *testing.T) {
	t.Parallel()

	var observed int
	svc := &mockWorkspaceRouteService{
		listUserWorkspacesFn: func(ctx context.Context, userID int64, page, perPage int) (services.UserWorkspaceListResult, error) {
			observed = perPage
			return services.UserWorkspaceListResult{}, nil
		},
	}
	h := &WorkspaceHandler{Service: svc}

	req := httptest.NewRequest(http.MethodGet, "/api/user/workspaces?limit=999", nil)
	req = withAuth(req, 42, "user42")
	h.GetUserWorkspaces(httptest.NewRecorder(), req)

	assert.Equal(t, services.MaxUserWorkspacesPerPage, observed, "handler must clamp limit to 100 before calling service")
}

func TestGetUserWorkspaces_RejectsInvalidLimit(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/user/workspaces?limit=-5", nil)
	req = withAuth(req, 42, "user42")
	rec := httptest.NewRecorder()
	h.GetUserWorkspaces(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestGetAuthenticatedUserReadableRepos_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &UserHandler{ProfileService: mockUserProfileService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/user/readable-repos", nil)
	rec := httptest.NewRecorder()
	h.GetAuthenticatedUserReadableRepos(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestGetAuthenticatedUserReadableRepos_ReturnsRows(t *testing.T) {
	t.Parallel()

	h := &UserHandler{ProfileService: mockUserProfileService{
		listReadableReposFn: func(ctx context.Context, userID int64, page, perPage int) (services.ReadableRepoListResult, error) {
			assert.Equal(t, int64(42), userID)
			return services.ReadableRepoListResult{
				Items: []services.ReadableRepoRow{
					{ID: 1, Owner: "alice", Name: "demo"},
					{ID: 2, Owner: "bob", Name: "other"},
				},
				TotalCount: 2,
				Page:       page,
				PerPage:    perPage,
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/user/readable-repos", nil)
	req = withAuth(req, 42, "user42")
	rec := httptest.NewRecorder()
	h.GetAuthenticatedUserReadableRepos(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var body []map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body, 2)
	assert.Equal(t, "alice", body[0]["owner"])
	assert.Equal(t, "demo", body[0]["name"])
}

func TestGetAuthenticatedUserReadableRepos_SetsPaginationHeaders(t *testing.T) {
	t.Parallel()

	h := &UserHandler{ProfileService: mockUserProfileService{
		listReadableReposFn: func(ctx context.Context, userID int64, page, perPage int) (services.ReadableRepoListResult, error) {
			return services.ReadableRepoListResult{
				Items: []services.ReadableRepoRow{
					{ID: 11, Owner: "alice", Name: "demo"},
					{ID: 10, Owner: "acme", Name: "tools"},
				},
				TotalCount: 4,
				Page:       page,
				PerPage:    perPage,
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/user/readable-repos?limit=2", nil)
	req = withAuth(req, 42, "user42")
	rec := httptest.NewRecorder()
	h.GetAuthenticatedUserReadableRepos(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "4", rec.Header().Get("X-Total-Count"))
	assert.Contains(t, rec.Header().Get("Link"), `rel="next"`)
	assert.Contains(t, rec.Header().Get("Link"), "page=2")
	assert.Contains(t, rec.Header().Get("Link"), "per_page=2")
}

func TestGetAuthenticatedUserReadableRepos_LimitCappedAt200(t *testing.T) {
	t.Parallel()

	var observed int
	h := &UserHandler{ProfileService: mockUserProfileService{
		listReadableReposFn: func(ctx context.Context, userID int64, page, perPage int) (services.ReadableRepoListResult, error) {
			observed = perPage
			return services.ReadableRepoListResult{}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/user/readable-repos?limit=9999", nil)
	req = withAuth(req, 42, "user42")
	h.GetAuthenticatedUserReadableRepos(httptest.NewRecorder(), req)

	assert.Equal(t, services.MaxReadableReposPerPage, observed, "handler must clamp limit to 200")
}

func TestGetAuthenticatedUserReadableRepos_RejectsInvalidLimit(t *testing.T) {
	t.Parallel()

	h := &UserHandler{ProfileService: mockUserProfileService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/user/readable-repos?limit=0", nil)
	req = withAuth(req, 42, "user42")
	rec := httptest.NewRecorder()
	h.GetAuthenticatedUserReadableRepos(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}
