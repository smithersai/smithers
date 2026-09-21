package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestWorkflowCache_Cov_RestoreAndBeginSaveBranches(t *testing.T) {
	t.Parallel()

	t.Run("restore requires service", func(t *testing.T) {
		t.Parallel()
		handler := WorkflowCacheHandler{}
		req := httptest.NewRequest(http.MethodPost, "/internal/caches/restore", bytes.NewBufferString(`{"key":"npm"}`))
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 42})
		rec := httptest.NewRecorder()
		handler.Restore(rec, req)

		assert.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "workflow cache service unavailable")
	})

	t.Run("restore requires workflow run context", func(t *testing.T) {
		t.Parallel()
		handler := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/caches/restore", bytes.NewBufferString(`{"key":"npm"}`))
		rec := httptest.NewRecorder()
		handler.Restore(rec, req)

		assert.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "workflow run context not loaded")
	})

	t.Run("restore returns miss response", func(t *testing.T) {
		t.Parallel()
		handler := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
			restoreFn: func(ctx context.Context, run db.WorkflowRun, key, cacheVersion string) (services.WorkflowCacheRestoreResult, error) {
				assert.Equal(t, int64(55), run.ID)
				assert.Equal(t, "npm", key)
				assert.Equal(t, "v1", cacheVersion)
				return services.WorkflowCacheRestoreResult{CacheHit: false}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/internal/caches/restore", bytes.NewBufferString(`{"key":"npm","cache_version":"v1"}`))
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 42})
		rec := httptest.NewRecorder()
		handler.Restore(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var got workflowCacheRestoreResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
		assert.False(t, got.Hit)
		assert.Zero(t, got.CacheID)
	})

	t.Run("begin save returns reservation", func(t *testing.T) {
		t.Parallel()
		now := time.Now().UTC()
		handler := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
			beginSaveFn: func(ctx context.Context, run db.WorkflowRun, key, cacheVersion string, objectSizeBytes int64) (services.WorkflowCacheSaveReservation, error) {
				assert.Equal(t, int64(55), run.ID)
				assert.Equal(t, "go-build", key)
				assert.Equal(t, "v2", cacheVersion)
				assert.Equal(t, int64(321), objectSizeBytes)
				return services.WorkflowCacheSaveReservation{
					Cache: db.WorkflowCache{
						ID:           12,
						RepositoryID: 42,
						BookmarkName: "main",
						CacheKey:     key,
						CacheVersion: cacheVersion,
						Compression:  "tar+zstd",
						Status:       "reserved",
						ExpiresAt:    now.Add(time.Hour),
						CreatedAt:    now,
						UpdatedAt:    now,
					},
					UploadURL:       "https://upload/cache",
					UploadHeaders:   map[string]string{"x-goog-if-generation-match": "0"},
					ArchiveMaxBytes: 1024,
				}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/internal/caches/save", bytes.NewBufferString(`{"key":"go-build","cache_version":"v2","object_size_bytes":321}`))
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 42})
		rec := httptest.NewRecorder()
		handler.BeginSave(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var got workflowCacheSaveResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
		assert.Equal(t, int64(12), got.CacheID)
		assert.Equal(t, "https://upload/cache", got.UploadURL)
		assert.Equal(t, map[string]string{"x-goog-if-generation-match": "0"}, got.UploadHeaders)
		assert.Equal(t, int64(1024), got.ArchiveMaxBytes)
	})

	t.Run("begin save propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
			beginSaveFn: func(context.Context, db.WorkflowRun, string, string, int64) (services.WorkflowCacheSaveReservation, error) {
				return services.WorkflowCacheSaveReservation{}, pkgerrors.Conflict("cache already finalized")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/internal/caches/save", bytes.NewBufferString(`{"key":"go-build","cache_version":"v2"}`))
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 42})
		rec := httptest.NewRecorder()
		handler.BeginSave(rec, req)

		assert.Equal(t, http.StatusConflict, rec.Code)
	})
}

func TestWorkflowCache_Cov_FinalizeAbortListStatsBranches(t *testing.T) {
	t.Parallel()

	t.Run("finalize rejects invalid cache id", func(t *testing.T) {
		t.Parallel()
		handler := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/caches/nope/finalize", bytes.NewBufferString(`{"object_size_bytes":1}`))
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 42})
		req = withRouteParams(req, map[string]string{"cache-id": "nope"})
		rec := httptest.NewRecorder()
		handler.FinalizeSave(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "invalid cache id")
	})

	t.Run("finalize propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
			finalizeSaveFn: func(context.Context, db.WorkflowRun, int64, int64) (db.WorkflowCache, error) {
				return db.WorkflowCache{}, pkgerrors.NotFound("cache not found")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/internal/caches/9/finalize", bytes.NewBufferString(`{"object_size_bytes":1}`))
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 42})
		req = withRouteParams(req, map[string]string{"cache-id": "9"})
		rec := httptest.NewRecorder()
		handler.FinalizeSave(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("abort save succeeds", func(t *testing.T) {
		t.Parallel()
		handler := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
			abortSaveFn: func(ctx context.Context, run db.WorkflowRun, cacheID int64) error {
				assert.Equal(t, int64(55), run.ID)
				assert.Equal(t, int64(9), cacheID)
				return nil
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/internal/caches/9/save", nil)
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 42})
		req = withRouteParams(req, map[string]string{"cache-id": "9"})
		rec := httptest.NewRecorder()
		handler.AbortSave(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("abort save propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
			abortSaveFn: func(context.Context, db.WorkflowRun, int64) error {
				return pkgerrors.Forbidden("permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/internal/caches/9/save", nil)
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 42})
		req = withRouteParams(req, map[string]string{"cache-id": "9"})
		rec := httptest.NewRecorder()
		handler.AbortSave(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("list caches rejects invalid pagination", func(t *testing.T) {
		t.Parallel()
		handler := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/caches?page=0", nil)
		req = withCacheRepoCtx(req)
		rec := httptest.NewRecorder()
		handler.ListCaches(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("stats propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
			statsFn: func(context.Context, int64) (services.WorkflowCacheStats, error) {
				return services.WorkflowCacheStats{}, pkgerrors.Forbidden("permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/caches/stats", nil)
		req = withCacheRepoCtx(req)
		rec := httptest.NewRecorder()
		handler.GetStats(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("map response includes nullable timestamps", func(t *testing.T) {
		t.Parallel()
		now := time.Now().UTC().Truncate(time.Second)
		runID := int64(55)
		got := mapWorkflowCacheResponse(db.WorkflowCache{
			ID:              9,
			RepositoryID:    42,
			WorkflowRunID:   pgtype.Int8{Int64: runID, Valid: true},
			BookmarkName:    "main",
			CacheKey:        "npm",
			CacheVersion:    "v1",
			ObjectKey:       "object",
			ObjectSizeBytes: 123,
			Compression:     "tar+gzip",
			Status:          "finalized",
			HitCount:        2,
			LastHitAt:       pgtype.Timestamptz{Time: now, Valid: true},
			FinalizedAt:     pgtype.Timestamptz{Time: now, Valid: true},
			ExpiresAt:       now.Add(time.Hour),
			CreatedAt:       now,
			UpdatedAt:       now,
		})

		require.NotNil(t, got.WorkflowRunID)
		assert.Equal(t, runID, *got.WorkflowRunID)
		require.NotNil(t, got.LastHitAt)
		assert.True(t, got.LastHitAt.Equal(now))
		require.NotNil(t, got.FinalizedAt)
		assert.True(t, got.FinalizedAt.Equal(now))
	})
}
