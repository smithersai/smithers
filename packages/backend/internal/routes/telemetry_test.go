package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestTelemetryHandler_PostClientError_ValidWebReport(t *testing.T) {
	t.Parallel()

	h := &TelemetryHandler{}
	body := `{"client":"web","version":"1.0","error":{"message":"test error","stack":"at main.go:1","type":"TypeError"},"context":{"url":"https://smithers.sh","user_agent":"test-agent"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/telemetry/errors", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.PostClientError(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestTelemetryHandler_PostClientError_ValidCLIReport(t *testing.T) {
	t.Parallel()

	h := &TelemetryHandler{}
	body := `{"client":"cli","version":"0.5.0","error":{"message":"network error","stack":"","type":"NetworkError"},"context":{"command":"push","os":"linux","arch":"amd64"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/telemetry/errors", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.PostClientError(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestTelemetryHandler_PostClientError_InvalidClient(t *testing.T) {
	t.Parallel()

	h := &TelemetryHandler{}
	body := `{"client":"mobile","version":"1.0","error":{"message":"err","stack":"","type":"Error"},"context":{}}`
	req := httptest.NewRequest(http.MethodPost, "/api/telemetry/errors", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.PostClientError(rec, req)

	// Invalid client is silently dropped with 204
	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestTelemetryHandler_PostClientError_InvalidJSON(t *testing.T) {
	t.Parallel()

	h := &TelemetryHandler{}
	req := httptest.NewRequest(http.MethodPost, "/api/telemetry/errors", strings.NewReader("not-json"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.PostClientError(rec, req)

	// Invalid JSON is silently dropped with 204
	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestTelemetryHandler_PostClientError_EmptyBody(t *testing.T) {
	t.Parallel()

	h := &TelemetryHandler{}
	req := httptest.NewRequest(http.MethodPost, "/api/telemetry/errors", strings.NewReader(""))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.PostClientError(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestTelemetryHandler_PostClientError_WithMetrics(t *testing.T) {
	t.Parallel()

	metrics := NewSmithersMetrics()
	h := &TelemetryHandler{Metrics: metrics}
	body := `{"client":"web","version":"1.0","error":{"message":"err","stack":"","type":"TypeError"},"context":{}}`
	req := httptest.NewRequest(http.MethodPost, "/api/telemetry/errors", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.PostClientError(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}
