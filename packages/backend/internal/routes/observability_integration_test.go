package routes_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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
// Observability integration tests
//
// These tests validate the full integration of observability endpoints within
// the HTTP router: /metrics, /healthz, /readyz, /health, and trace propagation.
// Reference: docs/specs/infra.md §8
// ---------------------------------------------------------------------------

// buildObservabilityRouter creates a minimal router with the spec middleware
// stack and all observability endpoints wired, matching what cmd/server/main.go does.
func buildObservabilityRouter(t *testing.T) (*chi.Mux, *routes.SmithersMetrics) {
	t.Helper()
	return buildObservabilityRouterWithDeps(t, nil, "")
}

func buildObservabilityRouterWithDeps(t *testing.T, db routes.HealthzChecker, repoHostURL string) (*chi.Mux, *routes.SmithersMetrics) {
	t.Helper()

	m := routes.NewSmithersMetrics()

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.RealIP(0))
	r.Use(middleware.JSONRecoverer)
	r.Use(middleware.JSONTimeout(30 * time.Second))

	// Health endpoints — not auth-protected (Kubernetes probes).
	r.Get("/health", routes.Health)

	healthzHandler := routes.NewHealthzHandler(db, repoHostURL)
	readyzHandler := routes.NewReadyzHandler(db, repoHostURL)
	r.Get("/healthz", healthzHandler.Healthz)
	r.Get("/readyz", readyzHandler.Readyz)

	// Prometheus metrics endpoint.
	r.Get("/metrics", m.Handler().ServeHTTP)

	return r, m
}

func TestHealthzAndReadyz_Return503WhenRepoHostProbeReturns5xx(t *testing.T) {
	t.Parallel()

	repoHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(repoHost.Close)

	r, _ := buildObservabilityRouterWithDeps(t, &healthyDB{}, repoHost.URL)

	t.Run("healthz", func(t *testing.T) {
		t.Parallel()

		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		require.Equal(t, http.StatusServiceUnavailable, rec.Code)

		var body struct {
			Status string `json:"status"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "unhealthy", body.Status)
	})

	t.Run("readyz", func(t *testing.T) {
		t.Parallel()

		req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		require.Equal(t, http.StatusServiceUnavailable, rec.Code)

		var body struct {
			Status string `json:"status"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "not_ready", body.Status)
	})
}

// ---------------------------------------------------------------------------
// /metrics endpoint — router integration
// ---------------------------------------------------------------------------

// TestMetricsEndpoint_RouterIntegration verifies that the /metrics endpoint is
// registered in the router and returns 200 with Prometheus text format.
func TestMetricsEndpoint_RouterIntegration(t *testing.T) {
	t.Parallel()

	r, _ := buildObservabilityRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code,
		"/metrics must return 200 when registered in the router")
	assert.Contains(t, rec.Header().Get("Content-Type"), "text/plain",
		"/metrics content-type must be Prometheus text format")
}

// TestMetricsEndpoint_ContainsAllRequiredMetrics verifies that all 10 metrics
// from infra.md §8.1 appear in the /metrics endpoint output through the router.
func TestMetricsEndpoint_ContainsAllRequiredMetrics(t *testing.T) {
	t.Parallel()

	r, m := buildObservabilityRouter(t)

	// Seed counters and histograms so they appear in Prometheus output.
	m.HTTPRequestsTotal.WithLabelValues("GET", "/api/repos", "200").Inc()
	m.HTTPRequestDurationSeconds.WithLabelValues("GET", "/api/repos").Observe(0.01)
	m.ObserveAgentSessionCompletion("completed")
	m.ObserveAgentSessionTimeout()
	m.WorkflowRunsTotal.WithLabelValues("success").Inc()
	m.WorkflowDurationSeconds.WithLabelValues("success").Observe(5.0)
	m.RepoHostOperationDurationSeconds.WithLabelValues("fetch").Observe(0.1)
	m.DBQueryDurationSeconds.WithLabelValues("ListRepos").Observe(0.002)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	body := rec.Body.String()
	requiredMetrics := []string{
		"smithers_http_requests_total",
		"smithers_http_request_duration_seconds",
		"smithers_active_agent_sessions",
		"smithers_agent_session_timeouts_total",
		"smithers_agent_sessions_completed_total",
		"smithers_runner_pool_available",
		"smithers_runner_pool_claimed",
		"smithers_workflow_runs_total",
		"smithers_workflow_duration_seconds",
		"smithers_repo_host_client_operation_duration_seconds",
		"smithers_db_query_duration_seconds",
		"smithers_sse_active_connections",
	}

	for _, metric := range requiredMetrics {
		assert.Contains(t, body, metric,
			"router /metrics endpoint must include metric %q per infra.md §8.1", metric)
	}
}

// TestMetricsEndpoint_ReflectsIncrementedCounters verifies that after processing
// requests, counter values are updated and visible via /metrics.
func TestMetricsEndpoint_ReflectsIncrementedCounters(t *testing.T) {
	t.Parallel()

	r, m := buildObservabilityRouter(t)

	// Manually increment as a future HTTP metrics middleware would do.
	m.HTTPRequestsTotal.WithLabelValues("GET", "/api/repos", "200").Add(3)
	m.HTTPRequestsTotal.WithLabelValues("POST", "/api/repos", "201").Inc()

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	body := rec.Body.String()
	assert.Contains(t, body,
		`smithers_http_requests_total{method="GET",path="/api/repos",status="200"} 3`,
		"GET counter must reflect 3 requests")
	assert.Contains(t, body,
		`smithers_http_requests_total{method="POST",path="/api/repos",status="201"} 1`,
		"POST counter must reflect 1 request")
}

// TestMetricsEndpoint_GaugesReflectSetValues verifies that gauge metrics
// set programmatically appear with the correct values at /metrics.
func TestMetricsEndpoint_GaugesReflectSetValues(t *testing.T) {
	t.Parallel()

	r, m := buildObservabilityRouter(t)

	m.ActiveAgentSessions.Set(7)
	m.RunnerPoolAvailable.Set(15)
	m.RunnerPoolClaimed.Set(3)
	m.WorkflowTaskQueueDepth.Set(4)
	m.WorkflowTaskQueueOldestAgeSeconds.Set(75)
	m.SSEActiveConnections.Set(12)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	body := rec.Body.String()
	assert.Contains(t, body, "smithers_active_agent_sessions 7",
		"active agent sessions gauge must be visible via router")
	assert.Contains(t, body, "smithers_runner_pool_available 15",
		"runner pool available gauge must be visible via router")
	assert.Contains(t, body, "smithers_runner_pool_claimed 3",
		"runner pool claimed gauge must be visible via router")
	assert.Contains(t, body, "smithers_workflow_task_queue_depth 4",
		"workflow task queue depth gauge must be visible via router")
	assert.Contains(t, body, "smithers_workflow_task_queue_oldest_age_seconds 75",
		"workflow task queue oldest age gauge must be visible via router")
	assert.Contains(t, body, "smithers_sse_active_connections 12",
		"SSE connections gauge must be visible via router")
}

// TestMetricsEndpoint_NotAuthProtected verifies that /metrics is accessible
// without any authentication headers (Prometheus scraper has no auth).
func TestMetricsEndpoint_NotAuthProtected(t *testing.T) {
	t.Parallel()

	r, _ := buildObservabilityRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	// Deliberately no Authorization header.
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code,
		"/metrics must not require authentication — Prometheus scrapers don't send auth")
}

// TestMetricsEndpoint_HelpAndTypeLines verifies Prometheus text format
// compliance: each metric must have # HELP and # TYPE lines.
func TestMetricsEndpoint_HelpAndTypeLines(t *testing.T) {
	t.Parallel()

	r, m := buildObservabilityRouter(t)

	// Seed to ensure all metrics appear.
	m.HTTPRequestsTotal.WithLabelValues("GET", "/probe", "200").Inc()
	m.HTTPRequestDurationSeconds.WithLabelValues("GET", "/probe").Observe(0.001)
	m.WorkflowRunsTotal.WithLabelValues("success").Inc()
	m.WorkflowDurationSeconds.WithLabelValues("success").Observe(1.0)
	m.RepoHostOperationDurationSeconds.WithLabelValues("push").Observe(0.05)
	m.DBQueryDurationSeconds.WithLabelValues("probe").Observe(0.001)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	body := rec.Body.String()

	// Verify HELP and TYPE for the spec metrics plus queue backlog gauges.
	type metricSpec struct {
		name       string
		metricType string
	}
	specs := []metricSpec{
		{"smithers_http_requests_total", "counter"},
		{"smithers_http_request_duration_seconds", "histogram"},
		{"smithers_active_agent_sessions", "gauge"},
		{"smithers_agent_session_timeouts_total", "counter"},
		{"smithers_agent_sessions_completed_total", "counter"},
		{"smithers_runner_pool_available", "gauge"},
		{"smithers_runner_pool_claimed", "gauge"},
		{"smithers_workflow_task_queue_depth", "gauge"},
		{"smithers_workflow_task_queue_oldest_age_seconds", "gauge"},
		{"smithers_workflow_runs_total", "counter"},
		{"smithers_workflow_duration_seconds", "histogram"},
		{"smithers_repo_host_client_operation_duration_seconds", "histogram"},
		{"smithers_db_query_duration_seconds", "histogram"},
		{"smithers_sse_active_connections", "gauge"},
	}

	for _, s := range specs {
		assert.Contains(t, body, "# HELP "+s.name,
			"metric %q must have # HELP line in Prometheus output", s.name)
		assert.Contains(t, body, "# TYPE "+s.name+" "+s.metricType,
			"metric %q must have correct # TYPE line in Prometheus output", s.name)
	}
}

// ---------------------------------------------------------------------------
// Health endpoints — router integration
// ---------------------------------------------------------------------------

// TestHealthEndpoints_AllRegisteredInRouter verifies that /health, /healthz,
// and /readyz are all accessible through the router.
func TestHealthEndpoints_AllRegisteredInRouter(t *testing.T) {
	t.Parallel()

	r, _ := buildObservabilityRouter(t)

	endpoints := []string{"/health", "/healthz", "/readyz"}
	for _, path := range endpoints {
		path := path
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodGet, path, nil)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusOK, rec.Code,
				"%s must return 200 (no dependencies configured in this test)", path)
		})
	}
}

// TestHealthEndpoints_NoAuthRequired verifies that health probes don't require
// authentication (Kubernetes probes don't send auth headers).
func TestHealthEndpoints_NoAuthRequired(t *testing.T) {
	t.Parallel()

	r, _ := buildObservabilityRouter(t)

	probes := []string{"/healthz", "/readyz", "/health"}
	for _, probe := range probes {
		probe := probe
		t.Run(probe, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodGet, probe, nil)
			// No Authorization header.
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusOK, rec.Code,
				"%s must be accessible without auth for K8s probes", probe)
		})
	}
}

// TestHealthz_And_Readyz_ReturnJSON verifies that /healthz and /readyz return
// JSON responses (not plain text like /health does).
func TestHealthz_And_Readyz_ReturnJSON(t *testing.T) {
	t.Parallel()

	r, _ := buildObservabilityRouter(t)

	for _, path := range []string{"/healthz", "/readyz"} {
		path := path
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodGet, path, nil)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusOK, rec.Code)
			assert.Contains(t, rec.Header().Get("Content-Type"), "application/json",
				"%s must return application/json", path)

			var body map[string]interface{}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body),
				"%s response must be valid JSON", path)
			assert.Contains(t, body, "status",
				"%s response must contain 'status' field", path)
			assert.Contains(t, body, "checks",
				"%s response must contain 'checks' field", path)
		})
	}
}

// TestHealthz_StatusFieldValues verifies contract vocabulary:
// /healthz uses "ok"/"unhealthy" and /readyz uses "ready"/"not_ready".
func TestHealthz_StatusFieldValues(t *testing.T) {
	t.Parallel()

	t.Run("healthz uses ok status when dependencies are healthy", func(t *testing.T) {
		t.Parallel()

		r, _ := buildObservabilityRouter(t)
		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		var body struct {
			Status string `json:"status"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "ok", body.Status,
			"/healthz must use 'ok' status value (not 'ready')")
	})

	t.Run("healthz uses unhealthy status when dependencies fail", func(t *testing.T) {
		t.Parallel()

		repoHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		t.Cleanup(repoHost.Close)

		r, _ := buildObservabilityRouterWithDeps(t, &healthyDB{}, repoHost.URL)
		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		var body struct {
			Status string `json:"status"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "unhealthy", body.Status,
			"/healthz must use 'unhealthy' status value when a dependency fails")
	})

	t.Run("readyz uses ready status when dependencies are healthy", func(t *testing.T) {
		t.Parallel()

		r, _ := buildObservabilityRouter(t)
		req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		var body struct {
			Status string `json:"status"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "ready", body.Status,
			"/readyz must use 'ready' status value (not 'ok')")
	})

	t.Run("readyz uses not_ready status when dependencies fail", func(t *testing.T) {
		t.Parallel()

		repoHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		t.Cleanup(repoHost.Close)

		r, _ := buildObservabilityRouterWithDeps(t, &healthyDB{}, repoHost.URL)
		req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		var body struct {
			Status string `json:"status"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "not_ready", body.Status,
			"/readyz must use 'not_ready' status value when a dependency fails")
	})
}

// TestHealth_ReturnPlainText verifies that /health returns plain text "ok"
// (suitable for load balancer health checks that don't parse JSON).
func TestHealth_ReturnPlainText(t *testing.T) {
	t.Parallel()

	r, _ := buildObservabilityRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "ok", rec.Body.String(),
		"/health must return plain 'ok' string for load balancer probes")
}

// ---------------------------------------------------------------------------
// Trace context propagation
// ---------------------------------------------------------------------------

// TestTraceContext_RequestIDInContext verifies that the RequestID middleware
// injects a request ID accessible to downstream handlers and middleware.
func TestTraceContext_RequestIDInContext(t *testing.T) {
	t.Parallel()

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)

	var capturedID string
	r.Get("/trace-test", func(w http.ResponseWriter, r *http.Request) {
		capturedID = chiMiddleware.GetReqID(r.Context())
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/trace-test", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.NotEmpty(t, capturedID,
		"RequestID middleware must inject a request ID for trace correlation")
}

// TestTraceContext_W3CTraceparentIsAccessible verifies that W3C Trace Context
// traceparent headers are preserved through the middleware stack so they can
// be used for distributed tracing correlation.
func TestTraceContext_W3CTraceparentIsAccessible(t *testing.T) {
	t.Parallel()

	// W3C Trace Context format: version-traceid-spanid-flags
	// https://www.w3.org/TR/trace-context/
	traceparent := "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

	r, _ := buildObservabilityRouter(t)

	var capturedTraceparent string
	r.Get("/trace-endpoint", func(w http.ResponseWriter, r *http.Request) {
		capturedTraceparent = r.Header.Get("Traceparent")
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/trace-endpoint", nil)
	req.Header.Set("Traceparent", traceparent)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, traceparent, capturedTraceparent,
		"W3C traceparent header must pass through the middleware stack for distributed tracing")
}

// TestTraceContext_TraceStateHeaderIsPreserved verifies that the W3C Trace Context
// tracestate header (vendor-specific trace metadata) is also preserved.
func TestTraceContext_TraceStateHeaderIsPreserved(t *testing.T) {
	t.Parallel()

	r, _ := buildObservabilityRouter(t)

	var capturedTracestate string
	r.Get("/trace-state-endpoint", func(w http.ResponseWriter, r *http.Request) {
		capturedTracestate = r.Header.Get("Tracestate")
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/trace-state-endpoint", nil)
	req.Header.Set("Traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	req.Header.Set("Tracestate", "google=AAAAAA,acme=XYZ123")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, "google=AAAAAA,acme=XYZ123", capturedTracestate,
		"W3C tracestate header must be preserved through the middleware stack")
}

// TestTraceContext_ClientSuppliedRequestIDIsPreserved verifies that when an
// upstream proxy sends X-Request-Id, the middleware uses it (not a generated one).
func TestTraceContext_ClientSuppliedRequestIDIsPreserved(t *testing.T) {
	t.Parallel()

	r, _ := buildObservabilityRouter(t)

	var capturedID string
	r.Get("/reqid-test", func(w http.ResponseWriter, r *http.Request) {
		capturedID = chiMiddleware.GetReqID(r.Context())
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/reqid-test", nil)
	req.Header.Set("X-Request-Id", "upstream-trace-id-abc123")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, "upstream-trace-id-abc123", capturedID,
		"Upstream X-Request-Id must be preserved for distributed trace correlation")
}

// ---------------------------------------------------------------------------
// Middleware stack — observability interaction
// ---------------------------------------------------------------------------

// TestObservabilityStack_RecovererDoesNotSuppressRequestID verifies that when
// a handler panics (and recoverer returns 500), the request ID is still set.
// This ensures trace IDs survive panics for debugging.
func TestObservabilityStack_RecovererDoesNotSuppressRequestID(t *testing.T) {
	t.Parallel()

	var capturedID string

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Capture the request ID before the handler panics.
			capturedID = chiMiddleware.GetReqID(r.Context())
			next.ServeHTTP(w, r)
		})
	})
	r.Use(middleware.JSONRecoverer)

	r.Get("/panic-route", func(w http.ResponseWriter, r *http.Request) {
		panic("test panic for trace correlation test")
	})

	req := httptest.NewRequest(http.MethodGet, "/panic-route", nil)
	req.Header.Set("X-Request-Id", "trace-before-panic-abc123")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, "trace-before-panic-abc123", capturedID,
		"Request ID must be captured before panic for trace correlation in error logs")
}

// ---------------------------------------------------------------------------
// SmithersMetrics — registry isolation and concurrency
// ---------------------------------------------------------------------------

// TestMetrics_MultipleRouterInstances verifies that multiple SmithersMetrics
// instances (as in tests) have isolated registries and don't conflict.
func TestMetrics_MultipleRouterInstances(t *testing.T) {
	t.Parallel()

	r1, m1 := buildObservabilityRouter(t)
	r2, m2 := buildObservabilityRouter(t)

	// Set different values in each instance.
	m1.ActiveAgentSessions.Set(5)
	m2.ActiveAgentSessions.Set(99)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)

	rec1 := httptest.NewRecorder()
	r1.ServeHTTP(rec1, req)

	rec2 := httptest.NewRecorder()
	r2.ServeHTTP(rec2, req)

	// Instance 1 should show 5, instance 2 should show 99.
	assert.Contains(t, rec1.Body.String(), "smithers_active_agent_sessions 5",
		"router instance 1 must use its own isolated metrics registry")
	assert.Contains(t, rec2.Body.String(), "smithers_active_agent_sessions 99",
		"router instance 2 must use its own isolated metrics registry")
}

// TestMetrics_WorkflowBuckets_VisibleInRouterOutput verifies the custom
// workflow duration histogram buckets (0.5s to 600s) appear via the router.
func TestMetrics_WorkflowBuckets_VisibleInRouterOutput(t *testing.T) {
	t.Parallel()

	r, m := buildObservabilityRouter(t)

	m.WorkflowDurationSeconds.WithLabelValues("success").Observe(10.0)
	m.WorkflowDurationSeconds.WithLabelValues("failure").Observe(30.0)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	body := rec.Body.String()

	// Custom buckets from infra.md §8.1: .5, 1, 5, 10, 30, 60, 120, 300, 600
	customBuckets := []string{`le="0.5"`, `le="1"`, `le="5"`, `le="10"`, `le="30"`, `le="60"`, `le="120"`, `le="300"`, `le="600"`}
	for _, bucket := range customBuckets {
		assert.Contains(t, body, bucket,
			"workflow duration histogram must include custom bucket %s per infra.md §8.1", bucket)
	}
}

// ---------------------------------------------------------------------------
// Prometheus text format compliance
// ---------------------------------------------------------------------------

// TestPrometheusFormat_MetricNamesHaveSmithersPrefix verifies all metrics in the
// router output follow the naming convention: smithers_{subsystem}_{name}_{unit}.
func TestPrometheusFormat_MetricNamesHaveSmithersPrefix(t *testing.T) {
	t.Parallel()

	r, m := buildObservabilityRouter(t)

	// Seed all metric types.
	m.HTTPRequestsTotal.WithLabelValues("GET", "/test", "200").Inc()
	m.HTTPRequestDurationSeconds.WithLabelValues("GET", "/test").Observe(0.01)
	m.WorkflowRunsTotal.WithLabelValues("success").Inc()
	m.WorkflowDurationSeconds.WithLabelValues("success").Observe(1.0)
	m.RepoHostOperationDurationSeconds.WithLabelValues("list").Observe(0.05)
	m.DBQueryDurationSeconds.WithLabelValues("GetRepo").Observe(0.001)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	lines := strings.Split(rec.Body.String(), "\n")
	for _, line := range lines {
		if strings.HasPrefix(line, "# HELP ") {
			parts := strings.Fields(line)
			if len(parts) >= 3 {
				metricName := parts[2]
				assert.True(t, strings.HasPrefix(metricName, "smithers_"),
					"all metrics must use 'smithers_' prefix, got: %q", metricName)
			}
		}
	}
}

// TestRequestIDEcho_GeneratedIDEchoedInResponse verifies that the RequestIDEcho
// middleware echoes the generated request ID in the response X-Request-Id header.
func TestRequestIDEcho_GeneratedIDEchoedInResponse(t *testing.T) {
	t.Parallel()

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.RequestIDEcho)

	r.Get("/echo-test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/echo-test", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	// The response must include X-Request-Id (echoed by RequestIDEcho middleware)
	assert.NotEmpty(t, rec.Header().Get("X-Request-Id"),
		"RequestIDEcho middleware must echo generated request ID in response")
}

// TestRequestIDEcho_ClientIDPreservedAndEchoed verifies that a client-supplied
// X-Request-Id is preserved by RequestID middleware and echoed by RequestIDEcho.
func TestRequestIDEcho_ClientIDPreservedAndEchoed(t *testing.T) {
	t.Parallel()

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.RequestIDEcho)

	r.Get("/echo-client-id", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	clientID := "client-trace-id-xyz-789"
	req := httptest.NewRequest(http.MethodGet, "/echo-client-id", nil)
	req.Header.Set("X-Request-Id", clientID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	// Client-supplied ID must be echoed back for upstream trace correlation
	assert.Equal(t, clientID, rec.Header().Get("X-Request-Id"),
		"Client-supplied X-Request-Id must be preserved and echoed in response for trace correlation")
}

// TestPrometheusFormat_HistogramHasSumAndCount verifies that histogram metrics
// expose _sum and _count lines in addition to _bucket lines.
func TestPrometheusFormat_HistogramHasSumAndCount(t *testing.T) {
	t.Parallel()

	r, m := buildObservabilityRouter(t)

	// Seed histograms with multiple observations.
	m.HTTPRequestDurationSeconds.WithLabelValues("GET", "/api/repos").Observe(0.005)
	m.HTTPRequestDurationSeconds.WithLabelValues("GET", "/api/repos").Observe(0.025)
	m.HTTPRequestDurationSeconds.WithLabelValues("GET", "/api/repos").Observe(0.1)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	body := rec.Body.String()

	// Prometheus histogram must have _sum, _count, and _bucket lines.
	assert.Contains(t, body, "smithers_http_request_duration_seconds_sum",
		"HTTP request duration histogram must expose _sum")
	assert.Contains(t, body, "smithers_http_request_duration_seconds_count",
		"HTTP request duration histogram must expose _count")
	assert.Contains(t, body, "smithers_http_request_duration_seconds_bucket",
		"HTTP request duration histogram must expose _bucket lines")
}
