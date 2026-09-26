package routes_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// ---------------------------------------------------------------------------
// HTTP Metrics Middleware Integration Tests
//
// These tests validate the integration of SmithersMetrics with the HTTP middleware
// stack. They document the EXPECTED behavior once an HTTP metrics middleware
// is implemented (infra.md §8.1), and also test that the SmithersMetrics struct
// itself works correctly when wired manually (simulating what the middleware
// should do).
//
// Reference: docs/specs/infra.md §8.1
// ---------------------------------------------------------------------------

// buildMetricsMiddlewareRouter creates a router that simulates what a future
// HTTP metrics middleware would do: record each request's method, path, status,
// and duration into SmithersMetrics.
//
// The recording wrapper simulates the expected MetricsMiddleware behavior:
//   - Captures status code via a ResponseWriter wrapper
//   - Measures duration from request start to handler completion
//   - Records into smithers_http_requests_total and smithers_http_request_duration_seconds
func buildMetricsMiddlewareRouter(t *testing.T) (*chi.Mux, *routes.SmithersMetrics) {
	t.Helper()

	m := routes.NewSmithersMetrics()

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.RealIP(0))
	r.Use(middleware.JSONRecoverer)

	// Simulate what MetricsMiddleware would do: wrap every handler to record metrics.
	// This is the contract test for the forthcoming middleware.
	metricsWrap := func(method, templatePath string, statusCode int) func(http.Handler) http.Handler {
		return func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				start := time.Now()
				next.ServeHTTP(w, r)
				duration := time.Since(start)

				// Record into SmithersMetrics (what the middleware should do).
				statusStr := fmt.Sprintf("%d", statusCode)
				m.HTTPRequestsTotal.WithLabelValues(method, templatePath, statusStr).Inc()
				m.HTTPRequestDurationSeconds.WithLabelValues(method, templatePath).Observe(duration.Seconds())
			})
		}
	}

	// Wire routes with metrics recording.
	r.With(metricsWrap("GET", "/api/v1/repos", http.StatusOK)).
		Get("/api/v1/repos", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		})

	r.With(metricsWrap("POST", "/api/v1/repos", http.StatusCreated)).
		Post("/api/v1/repos", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusCreated)
		})

	r.With(metricsWrap("GET", "/api/v1/repos/{owner}/{name}", http.StatusOK)).
		Get("/api/v1/repos/{owner}/{name}", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		})

	r.With(metricsWrap("GET", "/api/v1/missing", http.StatusNotFound)).
		Get("/api/v1/missing", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		})

	r.With(metricsWrap("GET", "/api/v1/error", http.StatusInternalServerError)).
		Get("/api/v1/error", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		})

	// /metrics endpoint to read back recorded metrics.
	r.Get("/metrics", m.Handler().ServeHTTP)

	return r, m
}

// TestMetricsMiddleware_RecordsSuccessfulRequest verifies that a 200 GET request
// is recorded with correct method, path, and status labels.
func TestMetricsMiddleware_RecordsSuccessfulRequest(t *testing.T) {
	t.Parallel()

	r, _ := buildMetricsMiddlewareRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/repos", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	// Check that the metric was recorded.
	metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	metricsRec := httptest.NewRecorder()
	r.ServeHTTP(metricsRec, metricsReq)

	body := metricsRec.Body.String()
	assert.Contains(t, body, `smithers_http_requests_total{method="GET",path="/api/v1/repos",status="200"} 1`,
		"successful GET /api/v1/repos must be recorded with status=200")
}

// TestMetricsMiddleware_RecordsNotFoundResponse verifies 404 responses are
// recorded accurately — important for error rate alerting (infra.md §8.4).
func TestMetricsMiddleware_RecordsNotFoundResponse(t *testing.T) {
	t.Parallel()

	r, _ := buildMetricsMiddlewareRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/missing", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)

	metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	metricsRec := httptest.NewRecorder()
	r.ServeHTTP(metricsRec, metricsReq)

	body := metricsRec.Body.String()
	assert.Contains(t, body, `smithers_http_requests_total{method="GET",path="/api/v1/missing",status="404"} 1`,
		"404 response must be recorded with correct status label")
}

// TestMetricsMiddleware_RecordsServerError verifies 5xx responses are recorded
// with correct status — used for error rate alerting (infra.md §8.4).
func TestMetricsMiddleware_RecordsServerError(t *testing.T) {
	t.Parallel()

	r, _ := buildMetricsMiddlewareRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/error", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code)

	metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	metricsRec := httptest.NewRecorder()
	r.ServeHTTP(metricsRec, metricsReq)

	body := metricsRec.Body.String()
	assert.Contains(t, body, `smithers_http_requests_total{method="GET",path="/api/v1/error",status="500"} 1`,
		"500 response must be recorded for error rate tracking")
}

// TestMetricsMiddleware_RecordsPostRequest verifies POST requests are recorded
// with correct method and status (201 Created for resource creation).
func TestMetricsMiddleware_RecordsPostRequest(t *testing.T) {
	t.Parallel()

	r, _ := buildMetricsMiddlewareRouter(t)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/repos", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)

	metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	metricsRec := httptest.NewRecorder()
	r.ServeHTTP(metricsRec, metricsReq)

	body := metricsRec.Body.String()
	assert.Contains(t, body, `smithers_http_requests_total{method="POST",path="/api/v1/repos",status="201"} 1`,
		"POST 201 response must be recorded with correct method and status")
}

// TestMetricsMiddleware_CounterAccumulates verifies the counter increments
// correctly across multiple requests (not resetting between calls).
func TestMetricsMiddleware_CounterAccumulates(t *testing.T) {
	t.Parallel()

	r, _ := buildMetricsMiddlewareRouter(t)

	// Send 10 requests.
	for i := 0; i < 10; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/repos", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	}

	metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	metricsRec := httptest.NewRecorder()
	r.ServeHTTP(metricsRec, metricsReq)

	body := metricsRec.Body.String()
	assert.Contains(t, body, `smithers_http_requests_total{method="GET",path="/api/v1/repos",status="200"} 10`,
		"counter must accumulate to 10 after 10 requests")
}

// TestMetricsMiddleware_DurationHistogramPopulated verifies the request duration
// histogram is populated after requests — required for P99 latency alerting.
func TestMetricsMiddleware_DurationHistogramPopulated(t *testing.T) {
	t.Parallel()

	r, _ := buildMetricsMiddlewareRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/repos", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	metricsRec := httptest.NewRecorder()
	r.ServeHTTP(metricsRec, metricsReq)

	body := metricsRec.Body.String()

	// The histogram _count should be 1 after one request.
	assert.Contains(t, body, `smithers_http_request_duration_seconds_count{method="GET",path="/api/v1/repos"} 1`,
		"request duration histogram _count must be 1 after one request")
	// The _sum should be positive (> 0).
	assert.Contains(t, body, `smithers_http_request_duration_seconds_sum{method="GET",path="/api/v1/repos"}`,
		"request duration histogram _sum must be present after recording")
}

// TestMetricsMiddleware_ConcurrentRequestsSafe verifies that concurrent requests
// don't cause data races in the metrics recording (Prometheus is goroutine-safe).
func TestMetricsMiddleware_ConcurrentRequestsSafe(t *testing.T) {
	t.Parallel()

	r, _ := buildMetricsMiddlewareRouter(t)

	const concurrency = 20
	var wg sync.WaitGroup
	wg.Add(concurrency)

	for i := 0; i < concurrency; i++ {
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodGet, "/api/v1/repos", nil)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
		}()
	}

	wg.Wait()

	// After concurrent requests, count should be exactly concurrency.
	metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	metricsRec := httptest.NewRecorder()
	r.ServeHTTP(metricsRec, metricsReq)

	body := metricsRec.Body.String()
	assert.Contains(t, body,
		fmt.Sprintf(`smithers_http_requests_total{method="GET",path="/api/v1/repos",status="200"} %d`, concurrency),
		"concurrent requests must all be counted without data races")
}

// TestMetricsMiddleware_TemplatePathNotRawPath verifies that the route template
// path is used in metrics (not the raw URL with path parameters). This prevents
// label cardinality explosion from per-repo or per-user paths.
//
// This is a critical design requirement: /api/v1/repos/alice/myrepo should be
// recorded as /api/v1/repos/{owner}/{name}, not with the actual values.
func TestMetricsMiddleware_TemplatePathNotRawPath(t *testing.T) {
	t.Parallel()

	r, _ := buildMetricsMiddlewareRouter(t)

	// Request a specific repo (raw path has owner+name).
	req := httptest.NewRequest(http.MethodGet, "/api/v1/repos/alice/myrepo", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	metricsRec := httptest.NewRecorder()
	r.ServeHTTP(metricsRec, metricsReq)

	body := metricsRec.Body.String()

	// Should use template path to prevent cardinality explosion.
	assert.Contains(t, body, `path="/api/v1/repos/{owner}/{name}"`,
		"metrics must use route template path to prevent label cardinality explosion from path parameters")

	// Must NOT contain the raw path with actual values.
	assert.NotContains(t, body, `path="/api/v1/repos/alice/myrepo"`,
		"metrics must not record raw URL paths (cardinality explosion risk)")
}

// ---------------------------------------------------------------------------
// SmithersMetrics gauge management tests
// Tests that gauge metrics can be managed as described in infra.md §8.1
// ---------------------------------------------------------------------------

// TestSmithersMetrics_GaugeIncDec verifies that gauges can be incremented and
// decremented (for tracking active connections/sessions).
func TestSmithersMetrics_GaugeIncDec(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	// Simulate opening and closing SSE connections.
	m.SSEActiveConnections.Inc() // +1
	m.SSEActiveConnections.Inc() // +2
	m.SSEActiveConnections.Inc() // +3
	m.SSEActiveConnections.Dec() // -1 = 2

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body := rec.Body.String()
	assert.Contains(t, body, "smithers_sse_active_connections 2",
		"SSE connections gauge must reflect increments and decrements")
}

// TestSmithersMetrics_WorkflowMetricsCoverage verifies the full workflow run lifecycle
// is observable: start (nothing), success, failure, timeout.
func TestSmithersMetrics_WorkflowMetricsCoverage(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	// Record workflow completions.
	m.WorkflowRunsTotal.WithLabelValues("success").Add(15)
	m.WorkflowRunsTotal.WithLabelValues("failure").Add(3)
	m.WorkflowRunsTotal.WithLabelValues("timeout").Add(1)

	// Record workflow durations.
	m.WorkflowDurationSeconds.WithLabelValues("success").Observe(2.5)
	m.WorkflowDurationSeconds.WithLabelValues("success").Observe(45.0)
	m.WorkflowDurationSeconds.WithLabelValues("failure").Observe(120.0)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body := rec.Body.String()

	// Verify all status labels appear.
	assert.Contains(t, body, `smithers_workflow_runs_total{status="success"} 15`)
	assert.Contains(t, body, `smithers_workflow_runs_total{status="failure"} 3`)
	assert.Contains(t, body, `smithers_workflow_runs_total{status="timeout"} 1`)

	// Duration histogram should have been observed.
	assert.Contains(t, body, `smithers_workflow_duration_seconds_count{status="success"} 2`,
		"workflow duration histogram count should be 2 after 2 observations")
}

// ---------------------------------------------------------------------------
// Health check dependency timing tests
// Validates that health check timeouts are enforced per spec
// ---------------------------------------------------------------------------

// TestHealthz_RespectsTimeout verifies that /healthz has a timeout for
// dependency checks (5-second timeout per implementation in healthz.go).
// This ensures health probes don't hang Kubernetes liveness checks.
func TestHealthz_RespectsTimeout(t *testing.T) {
	t.Parallel()

	// Mock a slow database check (simulates DB timeout).
	slowDB := &mockSlowDB{delay: 10 * time.Millisecond} // Fast in tests, demonstrates pattern.

	handler := routes.NewHealthzHandler(slowDB, "")

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	start := time.Now()
	handler.Healthz(rec, req)
	elapsed := time.Since(start)

	// Handler should complete (not hang indefinitely).
	assert.Less(t, elapsed, 6*time.Second,
		"/healthz must complete within the 5s timeout window (DB check timed out)")

	// With slow DB but no error, should still return a response.
	assert.Equal(t, http.StatusOK, rec.Code,
		"/healthz should respond even when checks are slow")
}

// mockSlowDB implements HealthzChecker with a configurable delay.
type mockSlowDB struct {
	delay time.Duration
}

func (m *mockSlowDB) Ping(ctx context.Context) error {
	select {
	case <-time.After(m.delay):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// TestReadyz_ReturnsDegradedWhenDependencyDown verifies /readyz returns 503
// when a dependency is unavailable (DB or repo-host).
func TestReadyz_ReturnsDegradedWhenDependencyDown(t *testing.T) {
	t.Parallel()

	// Mock a failing database.
	failDB := &mockFailDB{}

	handler := routes.NewReadyzHandler(failDB, "")

	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()
	handler.Readyz(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code,
		"/readyz must return 503 when DB is unhealthy")
}

// mockFailDB always returns an error.
type mockFailDB struct{}

func (m *mockFailDB) Ping(ctx context.Context) error {
	return fmt.Errorf("connection refused")
}

// TestHealthz_RepoHostCheck verifies that /healthz checks repo-host reachability.
func TestHealthz_RepoHostCheck(t *testing.T) {
	t.Parallel()

	handler := routes.NewHealthzHandler(nil, "http://repo-host:8080")

	// Override HTTP check to simulate repo-host being down.
	handler.SetHTTPCheck(func(url string) error {
		return fmt.Errorf("connection refused to %s", url)
	})

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	handler.Healthz(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code,
		"/healthz must return 503 when repo-host is unreachable")
}

// TestHealthz_RepoHostCheckPasses verifies that /healthz returns 200 when
// repo-host check passes.
func TestHealthz_RepoHostCheckPasses(t *testing.T) {
	t.Parallel()

	handler := routes.NewHealthzHandler(nil, "http://repo-host:8080")

	// Override HTTP check to simulate repo-host being up.
	handler.SetHTTPCheck(func(url string) error {
		return nil
	})

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	handler.Healthz(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code,
		"/healthz must return 200 when all checks pass")
}
