package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// TestJJVCSRoutes_GetChangeFiles_NotFoundEnvelope is an integration-style test
// that verifies HTTP envelope and status code at the router boundary when
// the repo-host returns a 404 Not Found response.
func TestJJVCSRoutes_GetChangeFiles_NotFoundEnvelope(t *testing.T) {
	t.Parallel()

	// Create a fake repo-host that returns 404
	fakeRepoHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"change not found in repo-host"}`))
	}))
	defer fakeRepoHost.Close()

	// Set up router with real JJVCSHandler
	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: fakeRepoHost.URL}, "test-token", nil)
	handler := &JJVCSHandler{RepoHost: client}

	router := chi.NewRouter()
	router.Get("/api/repos/{owner}/{repo}/changes/{change_id}/files", handler.GetChangeFiles)

	// Make request through router
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/nonexistent/files", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	// Verify status is 404 (not 500)
	assert.Equal(t, http.StatusNotFound, rec.Code)

	// Verify content type is JSON
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	// Verify response body is a valid JSON error envelope
	var envelope map[string]interface{}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))

	// Verify message field exists and contains upstream message
	msg, ok := envelope["message"].(string)
	require.True(t, ok, "response should have a 'message' field")
	assert.Contains(t, msg, "change not found")

	// Verify response does NOT contain internal fallback prefix
	assert.NotContains(t, msg, "failed to get change files:")
}

// TestJJVCSRoutes_GetChangeConflicts_NotFoundEnvelope verifies 404 envelope
// for the GetChangeConflicts endpoint through the router.
func TestJJVCSRoutes_GetChangeConflicts_NotFoundEnvelope(t *testing.T) {
	t.Parallel()

	fakeRepoHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"change not found"}`))
	}))
	defer fakeRepoHost.Close()

	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: fakeRepoHost.URL}, "test-token", nil)
	handler := &JJVCSHandler{RepoHost: client}

	router := chi.NewRouter()
	router.Get("/api/repos/{owner}/{repo}/changes/{change_id}/conflicts", handler.GetChangeConflicts)

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/bad-id/conflicts", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	var envelope map[string]interface{}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
	msg, ok := envelope["message"].(string)
	require.True(t, ok)
	assert.Contains(t, msg, "change not found")
	assert.NotContains(t, msg, "failed to get change conflicts:")
}

// TestJJVCSRoutes_ListOperations_NotFoundEnvelope verifies 404 envelope
// for the ListOperations endpoint through the router.
func TestJJVCSRoutes_ListOperations_NotFoundEnvelope(t *testing.T) {
	t.Parallel()

	fakeRepoHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"repository not found"}`))
	}))
	defer fakeRepoHost.Close()

	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: fakeRepoHost.URL}, "test-token", nil)
	handler := &JJVCSHandler{RepoHost: client}

	router := chi.NewRouter()
	router.Get("/api/repos/{owner}/{repo}/operations", handler.ListOperations)

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/nonexistent/operations", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	var envelope map[string]interface{}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
	msg, ok := envelope["message"].(string)
	require.True(t, ok)
	assert.Contains(t, msg, "repository not found")
	assert.NotContains(t, msg, "failed to list operations:")
}
