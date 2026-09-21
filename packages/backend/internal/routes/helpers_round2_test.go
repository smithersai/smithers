package routes

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestParseInt64RouteParam_Matrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for id := -10; id <= 110; id++ {
		id := id
		t.Run(fmt.Sprintf("id_%d", id), func(t *testing.T) {
			caseCount++
			req := httptest.NewRequest(http.MethodGet, "/labels", nil)
			req = withRouteParams(req, map[string]string{"id": fmt.Sprintf("%d", id)})
			got, err := parseInt64RouteParam(req, "id", "label id is required", "invalid label id")
			require.NoError(t, err)
			assert.Equal(t, int64(id), got)
		})
	}

	for _, raw := range []string{"", " ", "abc", "1.5"} {
		raw := raw
		t.Run("invalid_"+fmt.Sprintf("%q", raw), func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/labels", nil)
			req = withRouteParams(req, map[string]string{"id": raw})
			got, err := parseInt64RouteParam(req, "id", "label id is required", "invalid label id")
			wantMessage := "invalid label id"
			if raw == "" || raw == " " {
				wantMessage = "label id is required"
			}
			requireAPIErrorWithMessage(t, err, 400, wantMessage)
			assert.Zero(t, got)
		})
	}

	req := httptest.NewRequest(http.MethodGet, "/labels", nil)
	req = withRouteParams(req, map[string]string{"id": " 42 "})
	got, err := parseInt64RouteParam(req, "id", "label id is required", "invalid label id")
	require.NoError(t, err)
	assert.Equal(t, int64(42), got)

	assert.Equal(t, 121, caseCount)
}

func TestNormalizeBookmarkRef_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input string
		want  string
	}{
		{input: "main", want: "main"},
		{input: " main ", want: "main"},
		{input: "refs/heads/main", want: "main"},
		{input: "refs/heads/feature/test", want: "feature/test"},
		{input: " refs/heads/main ", want: "refs/heads/main"},
		{input: "refs/tags/v1.0.0", want: "refs/tags/v1.0.0"},
		{input: "", want: ""},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(fmt.Sprintf("bookmark_%q", tc.input), func(t *testing.T) {
			assert.Equal(t, tc.want, normalizeBookmarkRef(tc.input))
		})
	}
}

func TestParseWorkflowCacheID_Matrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for id := -5; id <= 105; id++ {
		id := id
		t.Run(fmt.Sprintf("cache_id_%d", id), func(t *testing.T) {
			caseCount++
			req := httptest.NewRequest(http.MethodGet, "/workflow-cache", nil)
			req = withRouteParams(req, map[string]string{"cache-id": fmt.Sprintf("%d", id)})
			got, err := parseWorkflowCacheID(req)
			if id <= 0 {
				requireAPIError(t, err, 400)
				assert.Zero(t, got)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, int64(id), got)
		})
	}

	for _, raw := range []string{"", "abc", "1.5", " 2 "} {
		raw := raw
		t.Run("cache_id_invalid_"+fmt.Sprintf("%q", raw), func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/workflow-cache", nil)
			req = withRouteParams(req, map[string]string{"cache-id": raw})
			got, err := parseWorkflowCacheID(req)
			requireAPIError(t, err, 400)
			assert.Zero(t, got)
		})
	}

	assert.Equal(t, 111, caseCount)
}

func TestMapWorkflowCacheResponse_Nullables(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 3, 12, 7, 0, 0, 0, time.UTC)
	tests := []struct {
		name string
		in   db.WorkflowCache
	}{
		{
			name: "with_nullable_fields",
			in: db.WorkflowCache{
				ID:              1,
				RepositoryID:    7,
				WorkflowRunID:   pgtype.Int8{Int64: 9, Valid: true},
				BookmarkName:    "main",
				CacheKey:        "npm",
				CacheVersion:    "v1",
				ObjectKey:       "cache/repos/7/x.tgz",
				ObjectSizeBytes: 1024,
				Compression:     "tar+gzip",
				Status:          "finalized",
				HitCount:        3,
				LastHitAt:       pgtype.Timestamptz{Time: now, Valid: true},
				FinalizedAt:     pgtype.Timestamptz{Time: now.Add(time.Minute), Valid: true},
				ExpiresAt:       now.Add(time.Hour),
				CreatedAt:       now,
				UpdatedAt:       now,
			},
		},
		{
			name: "without_nullable_fields",
			in: db.WorkflowCache{
				ID:              2,
				RepositoryID:    8,
				BookmarkName:    "main",
				CacheKey:        "pip",
				CacheVersion:    "static",
				ObjectKey:       "cache/repos/8/y.tgz",
				ObjectSizeBytes: 2048,
				Compression:     "tar+gzip",
				Status:          "pending",
				HitCount:        0,
				ExpiresAt:       now.Add(time.Hour),
				CreatedAt:       now,
				UpdatedAt:       now,
			},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got := mapWorkflowCacheResponse(tc.in)
			assert.Equal(t, tc.in.ID, got.ID)
			assert.Equal(t, tc.in.RepositoryID, got.RepositoryID)
			assert.Equal(t, tc.in.BookmarkName, got.BookmarkName)
			assert.Equal(t, tc.in.CacheKey, got.CacheKey)
			assert.Equal(t, tc.in.CacheVersion, got.CacheVersion)
			assert.Equal(t, tc.in.ObjectKey, got.ObjectKey)
			assert.Equal(t, tc.in.ObjectSizeBytes, got.ObjectSizeBytes)
			assert.Equal(t, tc.in.Compression, got.Compression)
			assert.Equal(t, tc.in.Status, got.Status)
			assert.Equal(t, tc.in.HitCount, got.HitCount)
			assert.Equal(t, tc.in.ExpiresAt, got.ExpiresAt)
			assert.Equal(t, tc.in.CreatedAt, got.CreatedAt)
			assert.Equal(t, tc.in.UpdatedAt, got.UpdatedAt)
			assert.Equal(t, tc.in.WorkflowRunID.Valid, got.WorkflowRunID != nil)
			assert.Equal(t, tc.in.LastHitAt.Valid, got.LastHitAt != nil)
			assert.Equal(t, tc.in.FinalizedAt.Valid, got.FinalizedAt != nil)
		})
	}
}
