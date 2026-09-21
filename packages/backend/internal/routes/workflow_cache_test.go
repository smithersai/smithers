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
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockWorkflowCacheRouteService struct {
	restoreFn      func(ctx context.Context, run db.WorkflowRun, key, cacheVersion string) (services.WorkflowCacheRestoreResult, error)
	beginSaveFn    func(ctx context.Context, run db.WorkflowRun, key, cacheVersion string, objectSizeBytes int64) (services.WorkflowCacheSaveReservation, error)
	finalizeSaveFn func(ctx context.Context, run db.WorkflowRun, cacheID, objectSizeBytes int64) (db.WorkflowCache, error)
	abortSaveFn    func(ctx context.Context, run db.WorkflowRun, cacheID int64) error
	listFn         func(ctx context.Context, repositoryID int64, filter services.WorkflowCacheListFilter) ([]db.WorkflowCache, error)
	clearFn        func(ctx context.Context, repositoryID int64, filter services.WorkflowCacheListFilter) (services.WorkflowCacheClearResult, error)
	statsFn        func(ctx context.Context, repositoryID int64) (services.WorkflowCacheStats, error)
}

func (m *mockWorkflowCacheRouteService) Restore(ctx context.Context, run db.WorkflowRun, key, cacheVersion string) (services.WorkflowCacheRestoreResult, error) {
	if m.restoreFn != nil {
		return m.restoreFn(ctx, run, key, cacheVersion)
	}
	return services.WorkflowCacheRestoreResult{}, nil
}

func (m *mockWorkflowCacheRouteService) BeginSave(ctx context.Context, run db.WorkflowRun, key, cacheVersion string, objectSizeBytes int64) (services.WorkflowCacheSaveReservation, error) {
	if m.beginSaveFn != nil {
		return m.beginSaveFn(ctx, run, key, cacheVersion, objectSizeBytes)
	}
	return services.WorkflowCacheSaveReservation{}, nil
}

func (m *mockWorkflowCacheRouteService) FinalizeSave(ctx context.Context, run db.WorkflowRun, cacheID, objectSizeBytes int64) (db.WorkflowCache, error) {
	if m.finalizeSaveFn != nil {
		return m.finalizeSaveFn(ctx, run, cacheID, objectSizeBytes)
	}
	return db.WorkflowCache{}, nil
}

func (m *mockWorkflowCacheRouteService) AbortSave(ctx context.Context, run db.WorkflowRun, cacheID int64) error {
	if m.abortSaveFn != nil {
		return m.abortSaveFn(ctx, run, cacheID)
	}
	return nil
}

func (m *mockWorkflowCacheRouteService) List(ctx context.Context, repositoryID int64, filter services.WorkflowCacheListFilter) ([]db.WorkflowCache, error) {
	if m.listFn != nil {
		return m.listFn(ctx, repositoryID, filter)
	}
	return nil, nil
}

func (m *mockWorkflowCacheRouteService) Clear(ctx context.Context, repositoryID int64, filter services.WorkflowCacheListFilter) (services.WorkflowCacheClearResult, error) {
	if m.clearFn != nil {
		return m.clearFn(ctx, repositoryID, filter)
	}
	return services.WorkflowCacheClearResult{}, nil
}

func (m *mockWorkflowCacheRouteService) Stats(ctx context.Context, repositoryID int64) (services.WorkflowCacheStats, error) {
	if m.statsFn != nil {
		return m.statsFn(ctx, repositoryID)
	}
	return services.WorkflowCacheStats{}, nil
}

func withWorkflowRunContext(req *http.Request, run db.WorkflowRun) *http.Request {
	ctx := middleware.ContextWithWorkflowRun(req.Context(), &run)
	return req.WithContext(ctx)
}

func TestWorkflowCacheHandler_Restore_ReturnsHitResponse(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	handler := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
		restoreFn: func(_ context.Context, run db.WorkflowRun, key, cacheVersion string) (services.WorkflowCacheRestoreResult, error) {
			assert.Equal(t, int64(55), run.ID)
			assert.Equal(t, "npm", key)
			assert.Equal(t, "abc123", cacheVersion)
			return services.WorkflowCacheRestoreResult{
				CacheHit:         true,
				ResolvedBookmark: "main",
				DownloadURL:      "https://cache.example/download",
				Cache: &db.WorkflowCache{
					ID:              9,
					RepositoryID:    42,
					WorkflowRunID:   pgtype.Int8{Int64: 55, Valid: true},
					BookmarkName:    "main",
					CacheKey:        "npm",
					CacheVersion:    "abc123",
					ObjectSizeBytes: 123,
					Compression:     "tar+gzip",
					Status:          "finalized",
					ExpiresAt:       now.Add(time.Hour),
					CreatedAt:       now,
					UpdatedAt:       now,
				},
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/internal/caches/restore", bytes.NewBufferString(`{"key":"npm","cache_version":"abc123"}`))
	req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 42})
	rec := httptest.NewRecorder()
	handler.Restore(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var response workflowCacheRestoreResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	assert.True(t, response.Hit)
	assert.Equal(t, int64(9), response.CacheID)
	assert.Equal(t, "main", response.BookmarkName)
	assert.Equal(t, "https://cache.example/download", response.DownloadURL)
	assert.Equal(t, int64(123), response.ObjectSizeBytes)
}

func TestWorkflowCacheHandler_FinalizeSave_DelegatesToService(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	handler := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
		finalizeSaveFn: func(_ context.Context, run db.WorkflowRun, cacheID, objectSizeBytes int64) (db.WorkflowCache, error) {
			assert.Equal(t, int64(55), run.ID)
			assert.Equal(t, int64(9), cacheID)
			assert.Equal(t, int64(456), objectSizeBytes)
			return db.WorkflowCache{
				ID:              9,
				RepositoryID:    42,
				WorkflowRunID:   pgtype.Int8{Int64: 55, Valid: true},
				BookmarkName:    "main",
				CacheKey:        "npm",
				CacheVersion:    "abc123",
				ObjectSizeBytes: 456,
				Compression:     "tar+gzip",
				Status:          "finalized",
				ExpiresAt:       now.Add(time.Hour),
				CreatedAt:       now,
				UpdatedAt:       now,
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/internal/caches/9/finalize", bytes.NewBufferString(`{"object_size_bytes":456}`))
	req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 42})
	req = withRouteParams(req, map[string]string{"cache-id": "9"})
	rec := httptest.NewRecorder()
	handler.FinalizeSave(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var response workflowCacheResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	assert.Equal(t, int64(9), response.ID)
	assert.Equal(t, int64(456), response.ObjectSizeBytes)
	assert.Equal(t, "finalized", response.Status)
}

func TestWorkflowCacheHandler_ListCaches_UsesRepoFilters(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	handler := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
		listFn: func(_ context.Context, repositoryID int64, filter services.WorkflowCacheListFilter) ([]db.WorkflowCache, error) {
			assert.Equal(t, int64(101), repositoryID)
			assert.Equal(t, 2, filter.Page)
			assert.Equal(t, 10, filter.PerPage)
			assert.Equal(t, "main", filter.Bookmark)
			assert.Equal(t, "npm", filter.CacheKey)
			return []db.WorkflowCache{{
				ID:              9,
				RepositoryID:    42,
				BookmarkName:    "main",
				CacheKey:        "npm",
				CacheVersion:    "abc123",
				ObjectSizeBytes: 456,
				Compression:     "tar+gzip",
				Status:          "finalized",
				ExpiresAt:       now.Add(time.Hour),
				CreatedAt:       now,
				UpdatedAt:       now,
			}}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/caches?page=2&per_page=10&bookmark=main&key=npm", nil)
	req = withRepoContext(req, "alice", "demo")
	rec := httptest.NewRecorder()
	handler.ListCaches(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var response []workflowCacheResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	require.Len(t, response, 1)
	assert.Equal(t, int64(9), response[0].ID)
	assert.Equal(t, "npm", response[0].CacheKey)
}

func TestWorkflowCacheHandler_ClearCaches_ReturnsTotals(t *testing.T) {
	t.Parallel()

	handler := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
		clearFn: func(_ context.Context, repositoryID int64, filter services.WorkflowCacheListFilter) (services.WorkflowCacheClearResult, error) {
			assert.Equal(t, int64(101), repositoryID)
			assert.Equal(t, "main", filter.Bookmark)
			assert.Equal(t, "npm", filter.CacheKey)
			return services.WorkflowCacheClearResult{
				DeletedCount: 2,
				DeletedBytes: 1234,
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/caches?bookmark=main&key=npm", nil)
	req = withRepoContext(req, "alice", "demo")
	rec := httptest.NewRecorder()
	handler.ClearCaches(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var response services.WorkflowCacheClearResult
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	assert.Equal(t, int64(2), response.DeletedCount)
	assert.Equal(t, int64(1234), response.DeletedBytes)
}

func TestWorkflowCacheHandler_GetStats_ReturnsRepositoryStats(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	handler := WorkflowCacheHandler{Service: &mockWorkflowCacheRouteService{
		statsFn: func(_ context.Context, repositoryID int64) (services.WorkflowCacheStats, error) {
			assert.Equal(t, int64(101), repositoryID)
			return services.WorkflowCacheStats{
				CacheCount:      3,
				TotalSizeBytes:  4096,
				RepoQuotaBytes:  8192,
				ArchiveMaxBytes: 1024,
				TTLSeconds:      604800,
				LastHitAt:       &now,
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/caches/stats", nil)
	req = withRepoContext(req, "alice", "demo")
	rec := httptest.NewRecorder()
	handler.GetStats(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var response services.WorkflowCacheStats
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	assert.Equal(t, int64(3), response.CacheCount)
	assert.Equal(t, int64(4096), response.TotalSizeBytes)
	assert.Equal(t, int64(8192), response.RepoQuotaBytes)
	require.NotNil(t, response.LastHitAt)
	assert.WithinDuration(t, now, *response.LastHitAt, time.Second)
}
