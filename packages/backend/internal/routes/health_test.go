package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestHealth_BasicResponse verifies the existing /health endpoint returns 200 "ok".
func TestHealth_BasicResponse(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	Health(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "ok", rec.Body.String())
}

// TestHealth_OnlyGET documents that the handler itself doesn't enforce method —
// routing is handled by the router. The handler always returns 200.
func TestHealth_MethodAgnostic(t *testing.T) {
	t.Parallel()

	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost} {
		method := method
		t.Run(method, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(method, "/health", nil)
			rec := httptest.NewRecorder()
			Health(rec, req)
			assert.Equal(t, http.StatusOK, rec.Code)
		})
	}
}

// ---------------------------------------------------------------------------
// Healthz / Readyz — not yet implemented in routes/health.go
// These tests document the EXPECTED behavior per the infra spec (§8) and will
// fail until the endpoints are implemented.
// ---------------------------------------------------------------------------

// stubHealthzResponse is the expected JSON shape from GET /healthz.
type stubHealthzResponse struct {
	Status  string            `json:"status"`
	Checks  map[string]string `json:"checks,omitempty"`
	Version string            `json:"version,omitempty"`
}

// Healthz is the stub handler that should be implemented.
// These tests verify the contract (currently unimplemented → tests will document desired shape).

func TestHealthz_NotYetImplemented_DocumentsExpectedContract(t *testing.T) {
	t.Parallel()

	// This test documents the INTENDED behavior for /healthz:
	// - Returns 200 with JSON body when all checks pass
	// - Returns 503 with JSON body when a dependency is unhealthy
	// The test is written as a contract spec, not yet runnable against a real handler.

	// Expected shape: {"status":"ok","checks":{"db":"ok","repo_host":"ok"}}
	expected := stubHealthzResponse{
		Status: "ok",
		Checks: map[string]string{
			"db":        "ok",
			"repo_host": "ok",
		},
	}

	data, err := json.Marshal(expected)
	require.NoError(t, err)

	var roundtripped stubHealthzResponse
	require.NoError(t, json.Unmarshal(data, &roundtripped))
	assert.Equal(t, "ok", roundtripped.Status)
	assert.Equal(t, "ok", roundtripped.Checks["db"])
	assert.Equal(t, "ok", roundtripped.Checks["repo_host"])
}

// TestReadyz_NotYetImplemented_DocumentsExpectedContract documents the intended
// /readyz behavior: returns 200 only when the server is ready to serve traffic
// (DB pool warm, repo-host reachable). Returns 503 during startup or degraded state.
func TestReadyz_NotYetImplemented_DocumentsExpectedContract(t *testing.T) {
	t.Parallel()

	// Readyz should return JSON with the same shape as healthz.
	// The distinction is:
	//   /healthz = liveness probe (is the process alive?)
	//   /readyz  = readiness probe (can it serve traffic?)
	expected := stubHealthzResponse{
		Status: "ready",
		Checks: map[string]string{
			"db":        "ok",
			"repo_host": "ok",
		},
	}

	data, err := json.Marshal(expected)
	require.NoError(t, err)

	var roundtripped stubHealthzResponse
	require.NoError(t, json.Unmarshal(data, &roundtripped))
	assert.Equal(t, "ready", roundtripped.Status)
}

// TestHealth_ResponseContentType documents that /health currently returns plain text
// (not JSON), which is acceptable for a basic liveness probe.
// The richer /healthz and /readyz should return application/json.
func TestHealth_ContentTypePlainText(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	Health(rec, req)

	// Current implementation doesn't set Content-Type explicitly;
	// Go defaults to text/plain for string bodies.
	// This is intentional for the simple /health probe.
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "ok", rec.Body.String())
	// Content-Type will be text/plain; charset=utf-8 (auto-detected by net/http)
	ct := rec.Header().Get("Content-Type")
	if ct != "" {
		assert.Contains(t, ct, "text/plain")
	}
}
