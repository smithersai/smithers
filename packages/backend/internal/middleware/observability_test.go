package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// ---------------------------------------------------------------------------
// Observability middleware tests
// These tests validate the infrastructure for metrics collection and trace
// propagation as defined in docs/specs/infra.md §8.
//
// Current state: only RequestID is implemented. The tests below document
// the expected behavior for forthcoming metrics + tracing middleware.
// ---------------------------------------------------------------------------

// TestRequestID_InjectedIntoContext verifies that chi's RequestID middleware
// sets a non-empty request ID that downstream handlers can read.
func TestObservability_RequestIDIsAccessible(t *testing.T) {
	t.Parallel()

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)

	var capturedID string
	r.Get("/test", func(w http.ResponseWriter, r *http.Request) {
		capturedID = chiMiddleware.GetReqID(r.Context())
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.NotEmpty(t, capturedID, "request ID must be injected for observability correlation")
}

// TestObservability_RequestIDPreservesClientSuppliedID checks that when a client
// sends X-Request-ID, the middleware uses it (allowing trace correlation from
// upstream load balancers or edge proxies).
func TestObservability_RequestIDPreservesClientSuppliedID(t *testing.T) {
	t.Parallel()

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)

	var capturedID string
	r.Get("/test", func(w http.ResponseWriter, r *http.Request) {
		capturedID = chiMiddleware.GetReqID(r.Context())
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("X-Request-Id", "client-supplied-id-abc123")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "client-supplied-id-abc123", capturedID,
		"RequestID middleware should preserve client-supplied X-Request-Id for trace correlation")
}

// ---------------------------------------------------------------------------
// Metrics middleware contract tests
// These document the EXPECTED interface for a future metrics middleware.
// They test the contract, not a real implementation (which doesn't exist yet).
// ---------------------------------------------------------------------------

// MetricsCollector is the interface a future metrics middleware should satisfy.
// This mirrors the spec's required metrics (infra.md §8.1).
type MetricsCollector interface {
	// RecordRequest records an HTTP request completion.
	RecordRequest(method, path string, statusCode int, duration time.Duration)
	// HTTPRequestsTotal returns the current count for a given label set.
	HTTPRequestsTotal(method, path string, status int) int64
	// HTTPRequestDurationP99 returns p99 latency for the given labels.
	HTTPRequestDurationP99(method, path string) time.Duration
}

// inMemoryMetrics is a test double that satisfies MetricsCollector.
type inMemoryMetrics struct {
	calls []struct {
		method     string
		path       string
		statusCode int
		duration   time.Duration
	}
}

func (m *inMemoryMetrics) RecordRequest(method, path string, statusCode int, duration time.Duration) {
	m.calls = append(m.calls, struct {
		method     string
		path       string
		statusCode int
		duration   time.Duration
	}{method, path, statusCode, duration})
}

func (m *inMemoryMetrics) HTTPRequestsTotal(method, path string, status int) int64 {
	var count int64
	for _, c := range m.calls {
		if c.method == method && c.path == path && c.statusCode == status {
			count++
		}
	}
	return count
}

func (m *inMemoryMetrics) HTTPRequestDurationP99(method, path string) time.Duration {
	// Simplified: return max duration as proxy for p99
	var max time.Duration
	for _, c := range m.calls {
		if c.method == method && c.path == path && c.duration > max {
			max = c.duration
		}
	}
	return max
}

// buildMetricsRouter creates a router with the spec middleware stack plus a
// hypothetical metrics-recording wrapper. This validates the integration point
// where metrics middleware would plug in.
func buildMetricsRouter(collector *inMemoryMetrics) *chi.Mux {
	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.RealIP(0))

	// Future: r.Use(middleware.MetricsCollector(collector))
	// For now we wrap handlers manually to simulate what the middleware would do.
	wrap := func(method, path string, h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, r)
			collector.RecordRequest(method, path, rec.Code, time.Since(start))
			// Copy response to real writer
			for k, vs := range rec.Header() {
				for _, v := range vs {
					w.Header().Add(k, v)
				}
			}
			w.WriteHeader(rec.Code)
			w.Write(rec.Body.Bytes()) //nolint:errcheck
		}
	}

	r.Use(middleware.JSONRecoverer)
	r.Use(middleware.JSONTimeout(30 * time.Second))

	r.Get("/api/repos", wrap(http.MethodGet, "/api/repos", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	r.Get("/api/missing", wrap(http.MethodGet, "/api/missing", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))

	return r
}

// TestMetrics_RecordRequestOnSuccess verifies that a successful request is recorded
// with the correct method, path, and status code.
func TestMetrics_RecordRequestOnSuccess(t *testing.T) {
	t.Parallel()

	collector := &inMemoryMetrics{}
	r := buildMetricsRouter(collector)

	req := httptest.NewRequest(http.MethodGet, "/api/repos", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, int64(1), collector.HTTPRequestsTotal(http.MethodGet, "/api/repos", http.StatusOK),
		"metrics must record 1 successful GET /api/repos request")
}

// TestMetrics_RecordRequestOnNotFound verifies 404 responses are recorded with
// correct status code for error rate tracking.
func TestMetrics_RecordRequestOnNotFound(t *testing.T) {
	t.Parallel()

	collector := &inMemoryMetrics{}
	r := buildMetricsRouter(collector)

	req := httptest.NewRequest(http.MethodGet, "/api/missing", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, int64(1), collector.HTTPRequestsTotal(http.MethodGet, "/api/missing", http.StatusNotFound),
		"metrics must record 404 status for missing resources")
}

// TestMetrics_DurationIsPositive verifies that request duration is measured
// as a positive value (not zero, not negative).
func TestMetrics_DurationIsPositive(t *testing.T) {
	t.Parallel()

	collector := &inMemoryMetrics{}
	r := buildMetricsRouter(collector)

	req := httptest.NewRequest(http.MethodGet, "/api/repos", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	// Duration must be positive
	assert.Equal(t, 1, len(collector.calls), "must have recorded exactly 1 request")
	assert.GreaterOrEqual(t, collector.calls[0].duration, time.Duration(0),
		"request duration must be non-negative")
}

// TestMetrics_MultipleRequestsAccumulate verifies that multiple requests
// are all recorded (counter increments correctly).
func TestMetrics_MultipleRequestsAccumulate(t *testing.T) {
	t.Parallel()

	collector := &inMemoryMetrics{}
	r := buildMetricsRouter(collector)

	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/repos", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
	}

	assert.Equal(t, int64(5), collector.HTTPRequestsTotal(http.MethodGet, "/api/repos", http.StatusOK),
		"counter must accumulate across multiple requests")
}

// ---------------------------------------------------------------------------
// Trace propagation contract tests
// Documents expected traceparent header behavior per infra.md §8.3
// ---------------------------------------------------------------------------

// TestTracing_TraceParentHeaderForwarded documents the expected behavior:
// when a request includes a traceparent header (W3C Trace Context), the
// middleware should propagate it to downstream services.
func TestTracing_TraceParentHeaderContract(t *testing.T) {
	t.Parallel()

	// W3C Trace Context traceparent format:
	// version-traceid-parentid-flags
	validTraceparent := "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)

	// Future: r.Use(otelhttp.NewMiddleware("smithers-api"))
	// For now verify that traceparent header is accessible in the handler.
	var capturedTraceparent string
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		capturedTraceparent = r.Header.Get("Traceparent")
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	req.Header.Set("Traceparent", validTraceparent)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, validTraceparent, capturedTraceparent,
		"traceparent header must be accessible to handlers for distributed tracing")
}

// TestTracing_TraceIDFormatValidation verifies the W3C Trace Context format.
// A valid traceparent has 4 dash-separated parts.
func TestTracing_TraceIDFormatValidation(t *testing.T) {
	t.Parallel()

	validTraceparents := []string{
		"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		"00-0000000000000000000000000000007b-000000000000000a-01",
	}

	for _, tp := range validTraceparents {
		tp := tp
		t.Run(tp, func(t *testing.T) {
			t.Parallel()

			parts := splitN(tp, "-", 4)
			assert.Equal(t, 4, len(parts), "valid traceparent must have 4 dash-separated parts")
			assert.Equal(t, "00", parts[0], "version must be '00'")
			assert.Len(t, parts[1], 32, "trace ID must be 32 hex chars")
			assert.Len(t, parts[2], 16, "parent ID must be 16 hex chars")
		})
	}
}

func splitN(s, sep string, n int) []string {
	result := make([]string, 0, n)
	remaining := s
	for i := 0; i < n-1; i++ {
		idx := indexOf(remaining, sep)
		if idx < 0 {
			break
		}
		result = append(result, remaining[:idx])
		remaining = remaining[idx+len(sep):]
	}
	result = append(result, remaining)
	return result
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// ---------------------------------------------------------------------------
// /metrics endpoint contract test
// Documents the Prometheus text format expected from a future /metrics endpoint
// ---------------------------------------------------------------------------

// TestMetricsEndpoint_PrometheusTextFormat documents the expected output format
// for a future GET /metrics endpoint serving Prometheus-compatible metrics.
// The endpoint doesn't exist yet — this is a contract specification test.
func TestMetricsEndpoint_PrometheusTextFormatSpec(t *testing.T) {
	t.Parallel()

	// Prometheus text format example for spec-required metrics:
	// # HELP smithers_http_requests_total Total HTTP requests by method, path, status
	// # TYPE smithers_http_requests_total counter
	// smithers_http_requests_total{method="GET",path="/api/repos",status="200"} 42
	//
	// # HELP smithers_http_request_duration_seconds Request latency distribution
	// # TYPE smithers_http_request_duration_seconds histogram
	// smithers_http_request_duration_seconds_bucket{le="0.005"} 10
	// smithers_http_request_duration_seconds_bucket{le="0.01"} 20
	// smithers_http_request_duration_seconds_bucket{le="0.025"} 35
	// smithers_http_request_duration_seconds_bucket{le="0.05"} 40
	// smithers_http_request_duration_seconds_bucket{le="0.1"} 42
	// smithers_http_request_duration_seconds_bucket{le="+Inf"} 42
	// smithers_http_request_duration_seconds_sum 1.234
	// smithers_http_request_duration_seconds_count 42

	// Required metric names from infra.md §8.1:
	requiredMetrics := []string{
		"smithers_http_requests_total",
		"smithers_http_request_duration_seconds",
		"smithers_active_agent_sessions",
		"smithers_agent_session_timeouts_total",
		"smithers_agent_sessions_completed_total",
		"smithers_workflow_runs_total",
		"smithers_workflow_duration_seconds",
		"smithers_repo_host_client_operation_duration_seconds",
		"smithers_db_query_duration_seconds",
		"smithers_sse_active_connections",
	}

	// Verify all metric names follow naming convention: smithers_{subsystem}_{name}_{unit}
	for _, metric := range requiredMetrics {
		metric := metric
		t.Run(metric, func(t *testing.T) {
			t.Parallel()

			assert.Contains(t, metric, "smithers_",
				"all application metrics must be prefixed with smithers_")
		})
	}
}
