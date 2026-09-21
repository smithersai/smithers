package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func withRepoContext(req *http.Request, owner, repo string) *http.Request {
	repository := &db.Repository{ID: 101, Name: repo, LowerName: repo}
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Owner:      owner,
		Repository: repository,
	}, middleware.PermissionRead)
	return req.WithContext(ctx)
}

func TestRepoHandler_UsesRepoContextWithoutRouteParams(t *testing.T) {
	t.Parallel()

	h := RepoHandler{Service: mockRepoRouteService{
		getRepoFn: func(ctx context.Context, viewer *db.User, owner, repo string) (db.Repository, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			return routeRepo(nil), nil
		},
	}, SSHHost: "smithers.test"}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil)
	req = withRepoContext(req, "alice", "demo")
	rec := httptest.NewRecorder()
	h.GetRepo(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestLandingHandler_UsesRepoContextWithoutRouteParams(t *testing.T) {
	t.Parallel()

	h := LandingHandler{Service: &mockLandingRouteService{
		listLandingRequestsFn: func(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.LandingRequestResponse, string, int64, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			return []services.LandingRequestResponse{}, "", 0, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings", nil)
	req = withRepoContext(req, "alice", "demo")
	rec := httptest.NewRecorder()
	h.ListLandingRequests(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestIssueHandler_UsesRepoContextWithoutRouteParams(t *testing.T) {
	t.Parallel()

	h := IssueHandler{Service: &mockIssueRouteService{
		listIssuesFn: func(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.IssueResponse, string, int64, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			return []services.IssueResponse{}, "", 0, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues", nil)
	req = withRepoContext(req, "alice", "demo")
	rec := httptest.NewRecorder()
	h.ListIssues(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestLabelHandler_UsesRepoContextWithoutRouteParams(t *testing.T) {
	t.Parallel()

	h := LabelHandler{Service: &mockLabelRouteService{
		listLabelsFn: func(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.Label, int64, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			return []db.Label{}, 0, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/labels", nil)
	req = withRepoContext(req, "alice", "demo")
	rec := httptest.NewRecorder()
	h.GetRepoLabels(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestWebhookHandler_UsesRepoContextWithoutRouteParams(t *testing.T) {
	t.Parallel()

	h := WebhookHandler{Service: &mockWebhookRouteService{
		listWebhooksFn: func(ctx context.Context, actor *db.User, owner, repo string) ([]db.Webhook, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			return []db.Webhook{}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/hooks", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.ListWebhooks(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}
