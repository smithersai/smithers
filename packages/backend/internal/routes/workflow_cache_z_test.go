package routes

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestWorkflowCache_Z_RestoreAndBeginSaveErrors(t *testing.T) {
	t.Parallel()

	t.Run("restore rejects malformed json", func(t *testing.T) {
		t.Parallel()
		h := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/caches/restore", bytes.NewBufferString(`{`))
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 1})
		rec := httptest.NewRecorder()

		h.Restore(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("restore propagates service error", func(t *testing.T) {
		t.Parallel()
		h := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
			restoreFn: func(context.Context, db.WorkflowRun, string, string) (services.WorkflowCacheRestoreResult, error) {
				return services.WorkflowCacheRestoreResult{}, pkgerrors.NotFound("cache miss")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/internal/caches/restore", bytes.NewBufferString(`{"key":"go","cache_version":"v1"}`))
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 1})
		rec := httptest.NewRecorder()

		h.Restore(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("begin save requires service", func(t *testing.T) {
		t.Parallel()
		req := httptest.NewRequest(http.MethodPost, "/internal/caches/save", bytes.NewBufferString(`{"key":"go"}`))
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 1})
		rec := httptest.NewRecorder()

		(&WorkflowCacheHandler{}).BeginSave(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("begin save requires workflow run context", func(t *testing.T) {
		t.Parallel()
		h := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/caches/save", bytes.NewBufferString(`{"key":"go"}`))
		rec := httptest.NewRecorder()

		h.BeginSave(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("begin save rejects malformed json", func(t *testing.T) {
		t.Parallel()
		h := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/caches/save", bytes.NewBufferString(`{`))
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 1})
		rec := httptest.NewRecorder()

		h.BeginSave(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

func TestWorkflowCache_Z_FinalizeAbortListClearStatsErrors(t *testing.T) {
	t.Parallel()

	t.Run("finalize requires service", func(t *testing.T) {
		t.Parallel()
		req := httptest.NewRequest(http.MethodPost, "/internal/caches/9/finalize", bytes.NewBufferString(`{"object_size_bytes":1}`))
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 1})
		req = withRouteParams(req, map[string]string{"cache-id": "9"})
		rec := httptest.NewRecorder()

		(&WorkflowCacheHandler{}).FinalizeSave(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("finalize requires workflow run context", func(t *testing.T) {
		t.Parallel()
		h := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/caches/9/finalize", bytes.NewBufferString(`{"object_size_bytes":1}`))
		req = withRouteParams(req, map[string]string{"cache-id": "9"})
		rec := httptest.NewRecorder()

		h.FinalizeSave(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("finalize rejects malformed json", func(t *testing.T) {
		t.Parallel()
		h := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/caches/9/finalize", bytes.NewBufferString(`{`))
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 1})
		req = withRouteParams(req, map[string]string{"cache-id": "9"})
		rec := httptest.NewRecorder()

		h.FinalizeSave(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("abort requires service", func(t *testing.T) {
		t.Parallel()
		req := httptest.NewRequest(http.MethodDelete, "/internal/caches/9/save", nil)
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 1})
		req = withRouteParams(req, map[string]string{"cache-id": "9"})
		rec := httptest.NewRecorder()

		(&WorkflowCacheHandler{}).AbortSave(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("abort requires workflow run context", func(t *testing.T) {
		t.Parallel()
		h := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/internal/caches/9/save", nil)
		req = withRouteParams(req, map[string]string{"cache-id": "9"})
		rec := httptest.NewRecorder()

		h.AbortSave(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("abort rejects invalid cache id", func(t *testing.T) {
		t.Parallel()
		h := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/internal/caches/0/save", nil)
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 1})
		req = withRouteParams(req, map[string]string{"cache-id": "0"})
		rec := httptest.NewRecorder()

		h.AbortSave(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("list requires service", func(t *testing.T) {
		t.Parallel()
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/caches", nil)
		req = withCacheRepoCtx(req)
		rec := httptest.NewRecorder()

		(&WorkflowCacheHandler{}).ListCaches(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("list requires repository context", func(t *testing.T) {
		t.Parallel()
		h := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/caches", nil)
		rec := httptest.NewRecorder()

		h.ListCaches(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("list propagates service error", func(t *testing.T) {
		t.Parallel()
		h := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
			listFn: func(context.Context, int64, services.WorkflowCacheListFilter) ([]db.WorkflowCache, error) {
				return nil, pkgerrors.Forbidden("permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/caches", nil)
		req = withCacheRepoCtx(req)
		rec := httptest.NewRecorder()

		h.ListCaches(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("clear requires service", func(t *testing.T) {
		t.Parallel()
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/caches", nil)
		req = withCacheRepoCtx(req)
		rec := httptest.NewRecorder()

		(&WorkflowCacheHandler{}).ClearCaches(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("clear requires repository context", func(t *testing.T) {
		t.Parallel()
		h := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/caches", nil)
		rec := httptest.NewRecorder()

		h.ClearCaches(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("stats requires service", func(t *testing.T) {
		t.Parallel()
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/caches/stats", nil)
		req = withCacheRepoCtx(req)
		rec := httptest.NewRecorder()

		(&WorkflowCacheHandler{}).GetStats(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}
