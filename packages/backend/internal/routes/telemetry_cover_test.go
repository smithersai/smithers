package routes

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func telemetryCovScrape(t *testing.T, metrics *SmithersMetrics) string {
	t.Helper()
	rec := httptest.NewRecorder()
	metrics.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	return string(body)
}

func TestTelemetry_Cov_PostClientErrorTruncatesAndIncrementsMetrics(t *testing.T) {
	t.Parallel()

	metrics := NewSmithersMetrics()
	h := &TelemetryHandler{Metrics: metrics}
	body := `{"client":"cli","version":"1.2.3","error":{"message":"` + strings.Repeat("m", maxErrorMessageLen+10) + `","stack":"` + strings.Repeat("s", maxErrorStackLen+10) + `","type":"Panic"},"context":{"command":"run","os":"darwin","arch":"arm64"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/telemetry/errors", strings.NewReader(body))
	rec := httptest.NewRecorder()

	h.PostClientError(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	output := telemetryCovScrape(t, metrics)
	assert.Contains(t, output, `smithers_client_errors_total{client="cli",error_type="Panic"} 1`)
}

func TestTelemetry_Cov_PostClientErrorBucketsUnknownErrorType(t *testing.T) {
	t.Parallel()

	metrics := NewSmithersMetrics()
	h := &TelemetryHandler{Metrics: metrics}
	attackTypes := []string{
		"ExploitA" + strings.Repeat("x", maxErrorTypeLen+16),
		"ExploitB" + strings.Repeat("y", maxErrorTypeLen+16),
	}

	for _, attackType := range attackTypes {
		body := `{"client":"web","version":"1.2.3","error":{"message":"boom","stack":"","type":"` + attackType + `"},"context":{}}`
		req := httptest.NewRequest(http.MethodPost, "/api/telemetry/errors", strings.NewReader(body))
		rec := httptest.NewRecorder()

		h.PostClientError(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
	}

	output := telemetryCovScrape(t, metrics)
	assert.Contains(t, output, `smithers_client_errors_total{client="web",error_type="other"} 2`)
	assert.NotContains(t, output, "ExploitA")
	assert.NotContains(t, output, "ExploitB")
}
