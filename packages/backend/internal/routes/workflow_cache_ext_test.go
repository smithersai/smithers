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
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func withCacheRepoCtx(req *http.Request) *http.Request {
	repository := &db.Repository{ID: 101, Name: "demo", LowerName: "demo"}
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Owner:      "alice",
		Repository: repository,
	}, middleware.PermissionWrite)
	return req.WithContext(ctx)
}

func TestWorkflowCacheHandler_GetStats_Success(t *testing.T) {
	t.Parallel()

	h := &WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
		statsFn: func(ctx context.Context, repositoryID int64) (services.WorkflowCacheStats, error) {
			assert.Equal(t, int64(101), repositoryID)
			return services.WorkflowCacheStats{CacheCount: 5, TotalSizeBytes: 1024}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflow-cache/stats", nil)
	req = withCacheRepoCtx(req)
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.GetStats(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var stats services.WorkflowCacheStats
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &stats))
	assert.Equal(t, int64(5), stats.CacheCount)
}

func TestWorkflowCacheHandler_ListCaches_Success(t *testing.T) {
	t.Parallel()

	h := &WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
		listFn: func(ctx context.Context, repositoryID int64, filter services.WorkflowCacheListFilter) ([]db.WorkflowCache, error) {
			assert.Equal(t, int64(101), repositoryID)
			return []db.WorkflowCache{}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflow-cache", nil)
	req = withCacheRepoCtx(req)
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.ListCaches(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestWorkflowCacheHandler_ClearCaches_ServiceError(t *testing.T) {
	t.Parallel()

	h := &WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
		clearFn: func(ctx context.Context, repositoryID int64, filter services.WorkflowCacheListFilter) (services.WorkflowCacheClearResult, error) {
			return services.WorkflowCacheClearResult{}, pkgerrors.Forbidden("permission denied")
		},
	}}

	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/workflow-cache", nil)
	req = withCacheRepoCtx(req)
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.ClearCaches(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
}

func TestWorkflowCacheHandler_GetStats_MissingRepoContext(t *testing.T) {
	t.Parallel()

	h := &WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflow-cache/stats", nil)
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.GetStats(rec, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
}
