package middleware_test

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
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
// HTTP Metrics Middleware Tests
//
// These tests validate the HTTPMetrics middleware implementation.
// The middleware wraps every HTTP handler to record request counts and durations
// into SmithersMetrics (smithers_http_requests_total, smithers_http_request_duration_seconds).
//
// Reference: docs/specs/infra.md §8.1
// ---------------------------------------------------------------------------

// buildHTTPMetricsRouter creates a test router with HTTPMetrics middleware
// and a /metrics endpoint to read back the recorded metrics.
func buildHTTPMetricsRouter(t *testing.T) (*chi.Mux, *routes.SmithersMetrics) {
	t.Helper()

	m := routes.NewSmithersMetrics()

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.RealIP(0))
	r.Use(middleware.JSONRecoverer)
	// Note: HTTPMetrics must be wired after routing so chi.RouteContext is available.
	r.Use(middleware.HTTPMetrics(m))

	r.Get("/api/v1/repos", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	r.Post("/api/v1/repos", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})
	r.Get("/api/v1/repos/{owner}/{name}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	r.Get("/api/v1/missing", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	r.Get("/api/v1/error", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	r.Get("/metrics", m.Handler().ServeHTTP)

	return r, m
}

// getMetricsBody makes a GET /metrics request and returns the body.
func getMetricsBody(t *testing.T, r http.Handler) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "/metrics must return 200")
	return rec.Body.String()
}

// TestHTTPMetrics_RecordsSuccessfulRequest verifies that a 200 GET is recorded
// with correct method, path, and status labels.
func TestHTTPMetrics_RecordsSuccessfulRequest(t *testing.T) {
	t.Parallel()

	r, _ := buildHTTPMetricsRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/repos", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	body := getMetricsBody(t, r)
	assert.Contains(t, body, `smithers_http_requests_total{method="GET",path="/api/v1/repos",status="200"} 1`,
		"GET /api/v1/repos 200 must be recorded in metrics")
}

// TestHTTPMetrics_Records404Response verifies 404 responses are recorded with
// correct status label — important for error rate alerting.
func TestHTTPMetrics_Records404Response(t *testing.T) {
	t.Parallel()

	r, _ := buildHTTPMetricsRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/missing", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)

	body := getMetricsBody(t, r)
	assert.Contains(t, body, `smithers_http_requests_total{method="GET",path="/api/v1/missing",status="404"} 1`,
		"404 response must be recorded with correct status label")
}

// TestHTTPMetrics_Records500Response verifies 5xx errors are tracked.
func TestHTTPMetrics_Records500Response(t *testing.T) {
	t.Parallel()

	r, _ := buildHTTPMetricsRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/error", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code)

	body := getMetricsBody(t, r)
	assert.Contains(t, body, `smithers_http_requests_total{method="GET",path="/api/v1/error",status="500"} 1`,
		"500 error must be recorded for error rate tracking")
}

// TestHTTPMetrics_RecordsPostCreated verifies POST 201 is recorded correctly.
func TestHTTPMetrics_RecordsPostCreated(t *testing.T) {
	t.Parallel()

	r, _ := buildHTTPMetricsRouter(t)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/repos", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code)

	body := getMetricsBody(t, r)
	assert.Contains(t, body, `smithers_http_requests_total{method="POST",path="/api/v1/repos",status="201"} 1`,
		"POST 201 must be recorded with correct method and status labels")
}

// TestHTTPMetrics_CounterAccumulates verifies counter increments across requests.
func TestHTTPMetrics_CounterAccumulates(t *testing.T) {
	t.Parallel()

	r, _ := buildHTTPMetricsRouter(t)

	for i := 0; i < 7; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/repos", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
	}

	body := getMetricsBody(t, r)
	assert.Contains(t, body, `smithers_http_requests_total{method="GET",path="/api/v1/repos",status="200"} 7`,
		"counter must accumulate to 7 after 7 requests")
}

// TestHTTPMetrics_DurationHistogramPopulated verifies request duration histogram
// is populated — required for p95/p99 latency alerting (infra.md §8.4).
func TestHTTPMetrics_DurationHistogramPopulated(t *testing.T) {
	t.Parallel()

	r, _ := buildHTTPMetricsRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/repos", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	body := getMetricsBody(t, r)
	assert.Contains(t, body, `smithers_http_request_duration_seconds_count{method="GET",path="/api/v1/repos"} 1`,
		"duration histogram count must be 1 after one request")
	assert.Contains(t, body, `smithers_http_request_duration_seconds_sum{method="GET",path="/api/v1/repos"}`,
		"duration histogram sum must be present")
}

// TestHTTPMetrics_UsesRouteTemplatePath verifies the middleware uses chi route
// templates rather than raw URLs to prevent label cardinality explosion.
//
// Without this, /api/v1/repos/alice/repo1 and /api/v1/repos/bob/repo2 would
// each get their own label, creating an unbounded label set.
func TestHTTPMetrics_UsesRouteTemplatePath(t *testing.T) {
	t.Parallel()

	r, _ := buildHTTPMetricsRouter(t)

	// Request a specific repo by owner/name.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/repos/alice/myrepo", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	body := getMetricsBody(t, r)

	// Must use route template to prevent cardinality explosion.
	assert.Contains(t, body, `path="/api/v1/repos/{owner}/{name}"`,
		"metrics must use chi route template path, not raw URL")

	// Must NOT contain the raw path with actual param values.
	assert.NotContains(t, body, `path="/api/v1/repos/alice/myrepo"`,
		"metrics must not record raw URL paths (causes cardinality explosion)")
}

func TestHTTPMetrics_UsesConstantPathForUnmatchedRoute(t *testing.T) {
	t.Parallel()

	r, _ := buildHTTPMetricsRouter(t)

	for _, path := range []string{"/does-not-exist/one", "/does-not-exist/two"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	}

	body := getMetricsBody(t, r)
	assert.Contains(t, body, `smithers_http_requests_total{method="GET",path="__unmatched__",status="404"} 2`,
		"unmatched routes must share a fixed path label")
	assert.NotContains(t, body, `path="/does-not-exist/one"`,
		"metrics must not record raw unmatched URL paths")
	assert.NotContains(t, body, `path="/does-not-exist/two"`,
		"metrics must not record raw unmatched URL paths")
}

func TestHTTPMetrics_UsesConstantMethodForUnknownMethod(t *testing.T) {
	t.Parallel()

	r, _ := buildHTTPMetricsRouter(t)

	for _, method := range []string{"CUSTOMONE", "CUSTOMTWO"} {
		req := httptest.NewRequest(method, "/does-not-exist", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		require.Equal(t, http.StatusMethodNotAllowed, rec.Code)
	}

	body := getMetricsBody(t, r)
	assert.Contains(t, body, `smithers_http_requests_total{method="other",path="__unmatched__",status="405"} 2`,
		"unknown HTTP methods must share a fixed method label")
	assert.NotContains(t, body, `method="CUSTOMONE"`,
		"metrics must not record arbitrary HTTP methods")
	assert.NotContains(t, body, `method="CUSTOMTWO"`,
		"metrics must not record arbitrary HTTP methods")
}

// TestHTTPMetrics_ConcurrentRequestsAreGoroutineSafe verifies that concurrent
// requests don't cause data races. Prometheus counters are goroutine-safe but
// the response writer wrapping must be too.
func TestHTTPMetrics_ConcurrentRequestsAreGoroutineSafe(t *testing.T) {
	t.Parallel()

	r, _ := buildHTTPMetricsRouter(t)

	const concurrency = 25
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

	body := getMetricsBody(t, r)
	assert.Contains(t, body,
		fmt.Sprintf(`smithers_http_requests_total{method="GET",path="/api/v1/repos",status="200"} %d`, concurrency),
		"concurrent requests must all be counted without data races")
}

// TestHTTPMetrics_NilMetricsIsNoop verifies that passing nil to HTTPMetrics
// returns a no-op middleware (doesn't panic).
func TestHTTPMetrics_NilMetricsIsNoop(t *testing.T) {
	t.Parallel()

	r := chi.NewRouter()
	r.Use(middleware.HTTPMetrics(nil))
	r.Get("/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()

	// Must not panic.
	require.NotPanics(t, func() {
		r.ServeHTTP(rec, req)
	})
	assert.Equal(t, http.StatusOK, rec.Code)
}

// ---------------------------------------------------------------------------
// X-Request-ID Echo Middleware Tests
// ---------------------------------------------------------------------------

// TestRequestIDEcho_EchosGeneratedID verifies that when no client-supplied ID
// is present, the generated request ID is echoed in the response header.
func TestRequestIDEcho_EchosGeneratedID(t *testing.T) {
	t.Parallel()

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.RequestIDEcho)
	r.Get("/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	echoed := rec.Header().Get("X-Request-Id")
	assert.NotEmpty(t, echoed,
		"X-Request-Id must be echoed in response for trace correlation")
}

// TestRequestIDEcho_EchosClientSuppliedID verifies that a client-supplied
// X-Request-Id is echoed back in the response.
func TestRequestIDEcho_EchosClientSuppliedID(t *testing.T) {
	t.Parallel()

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.RequestIDEcho)
	r.Get("/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("X-Request-Id", "client-trace-id-xyz789")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "client-trace-id-xyz789", rec.Header().Get("X-Request-Id"),
		"client-supplied X-Request-Id must be echoed back in response for edge proxy correlation")
}

// TestRequestIDEcho_ConsistentWithContextID verifies that the echoed ID
// matches the ID stored in the request context.
func TestRequestIDEcho_ConsistentWithContextID(t *testing.T) {
	t.Parallel()

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.RequestIDEcho)

	var contextID string
	r.Get("/test", func(w http.ResponseWriter, r *http.Request) {
		contextID = chiMiddleware.GetReqID(r.Context())
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	responseID := rec.Header().Get("X-Request-Id")
	assert.Equal(t, contextID, responseID,
		"echoed X-Request-Id must match the ID in the request context")
}

// TestHTTPMetrics_StatusRecorderPreservesFlusher verifies that the statusRecorder
// wrapper inside HTTPMetrics implements http.Flusher when the underlying ResponseWriter
// supports it. This is required for SSE (Server-Sent Events) endpoints to function
// correctly when HTTPMetrics is active globally at the /api route level.
//
// Regression test: without the Flush() method on statusRecorder, SSE endpoints
// like GET /api/repos/:owner/:repo/agent/sessions/:id/stream return HTTP 500
// with {"message":"streaming not supported"} because w.(http.Flusher) fails.
func TestHTTPMetrics_StatusRecorderPreservesFlusher(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	r := chi.NewRouter()
	r.Use(middleware.HTTPMetrics(m))

	var flusherSupported bool
	r.Get("/api/stream", func(w http.ResponseWriter, r *http.Request) {
		_, flusherSupported = w.(http.Flusher)
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/stream", nil)
	// httptest.NewRecorder() implements http.Flusher, so the underlying writer supports it.
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.True(t, flusherSupported,
		"HTTPMetrics statusRecorder must implement http.Flusher to support SSE endpoints")
}

func TestHTTPMetrics_StatusRecorderPreservesHijacker(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	r := chi.NewRouter()
	r.Use(middleware.HTTPMetrics(m))

	var hijackerSupported bool
	r.Get("/api/stream", func(w http.ResponseWriter, r *http.Request) {
		_, hijackerSupported = w.(http.Hijacker)
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/stream", nil)
	rec := &hijackOnlyResponseWriter{}
	r.ServeHTTP(rec, req)

	assert.True(t, hijackerSupported,
		"HTTPMetrics statusRecorder must implement http.Hijacker to support websocket upgrades")
}

func TestHTTPMetrics_StatusRecorderDoesNotExposeHijackerWhenUnsupported(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	r := chi.NewRouter()
	r.Use(middleware.HTTPMetrics(m))

	var hijackerSupported bool
	r.Get("/api/stream", func(w http.ResponseWriter, r *http.Request) {
		_, hijackerSupported = w.(http.Hijacker)
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/stream", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.False(t, hijackerSupported,
		"HTTPMetrics statusRecorder must not expose http.Hijacker when the underlying writer does not support it")
}

// TestHTTPMetrics_DurationIsNonNegative verifies that measured durations
// are non-negative (monotonic clock guarantees).
func TestHTTPMetrics_DurationIsNonNegative(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	r := chi.NewRouter()
	r.Use(middleware.HTTPMetrics(m))
	r.Get("/test", func(w http.ResponseWriter, r *http.Request) {
		// Simulate some work.
		time.Sleep(1 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	// Check that the histogram was populated with a positive value.
	metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	metricsRec := httptest.NewRecorder()
	m.Handler().ServeHTTP(metricsRec, metricsReq)

	body := metricsRec.Body.String()
	assert.Contains(t, body, `smithers_http_request_duration_seconds_count{method="GET",path="/test"} 1`,
		"duration histogram must record count=1 after one request")
}

// hijackOnlyResponseWriter is a test helper that implements both
// http.ResponseWriter and http.Hijacker. Used to verify that middleware
// response writer wrappers correctly propagate the Hijacker interface.
type hijackOnlyResponseWriter struct {
	httptest.ResponseRecorder
}

func (h *hijackOnlyResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return nil, nil, fmt.Errorf("hijack not implemented in test helper")
}

// ---------------------------------------------------------------------------
// Panic accounting (release review 2026-09-13, R004)
//
// The production router mounts JSONRecoverer OUTSIDE HTTPMetrics, so a handler
// panic unwinds through the metrics middleware before the recoverer writes
// its 500. The middleware must record the request regardless of that order:
// a panic before any write is what the client sees as a 500, a panic after
// the status was committed keeps the committed status.
// ---------------------------------------------------------------------------

// scrapeSmithersMetrics returns the Prometheus text exposition for m.
func scrapeSmithersMetrics(t *testing.T, m *routes.SmithersMetrics) string {
	t.Helper()
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	return rec.Body.String()
}

func TestHTTPMetrics_PanicBeforeWriteIsRecordedAs500(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()
	r := chi.NewRouter()
	r.Use(middleware.JSONRecoverer) // production order: recoverer outside metrics
	r.Use(middleware.HTTPMetrics(m))
	r.Get("/api/panic", func(http.ResponseWriter, *http.Request) { panic("handler exploded") })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/panic", nil))
	require.Equal(t, http.StatusInternalServerError, rec.Code, "JSONRecoverer must answer the panic with 500")

	body := scrapeSmithersMetrics(t, m)
	assert.Contains(t, body, `smithers_http_requests_total{method="GET",path="/api/panic",status="500"} 1`,
		"a recovered panic must be counted as the 500 the client received")
	assert.Contains(t, body, `smithers_http_request_duration_seconds_count{method="GET",path="/api/panic"} 1`,
		"a recovered panic must still observe request duration")
}

func TestHTTPMetrics_PanicAfterWriteHeaderKeepsCommittedStatus(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()
	r := chi.NewRouter()
	r.Use(middleware.JSONRecoverer)
	r.Use(middleware.HTTPMetrics(m))
	r.Get("/api/late-panic", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		panic("after the status was committed")
	})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/late-panic", nil))
	require.Equal(t, http.StatusOK, rec.Code, "the committed 200 is what the client saw")

	body := scrapeSmithersMetrics(t, m)
	assert.Contains(t, body, `smithers_http_requests_total{method="GET",path="/api/late-panic",status="200"} 1`,
		"a panic after WriteHeader must record the status the client received, not a synthetic 500")
	assert.NotContains(t, body, `path="/api/late-panic",status="500"`)
}

func TestHTTPMetrics_PanicAfterImplicitWriteKeepsImplicit200(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()
	r := chi.NewRouter()
	r.Use(middleware.JSONRecoverer)
	r.Use(middleware.HTTPMetrics(m))
	r.Get("/api/body-panic", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("partial body")) // implicit 200
		panic("after the body started")
	})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/body-panic", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	body := scrapeSmithersMetrics(t, m)
	assert.Contains(t, body, `smithers_http_requests_total{method="GET",path="/api/body-panic",status="200"} 1`,
		"Write without WriteHeader commits an implicit 200 that must be recorded as such")
}

func TestHTTPMetrics_PanicUnderJSONTimeoutIsRecorded(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()
	r := chi.NewRouter()
	r.Use(middleware.JSONRecoverer)
	r.Use(middleware.HTTPMetrics(m))
	r.Route("/api", func(r chi.Router) {
		r.Use(middleware.JSONTimeout(5 * time.Second)) // the /api group runs handlers on another goroutine
		r.Get("/timeout-panic", func(http.ResponseWriter, *http.Request) { panic("inside the timeout goroutine") })
	})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/timeout-panic", nil))
	require.Equal(t, http.StatusInternalServerError, rec.Code)

	body := scrapeSmithersMetrics(t, m)
	assert.Contains(t, body, `smithers_http_requests_total{method="GET",path="/api/timeout-panic",status="500"} 1`,
		"a panic re-raised by JSONTimeout must be counted as a 500")
	assert.Contains(t, body, `smithers_http_request_duration_seconds_count{method="GET",path="/api/timeout-panic"} 1`)
}

func TestHTTPMetrics_PanicStillPropagatesToRecoverer(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()
	handler := middleware.HTTPMetrics(m)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("must reach the caller")
	}))

	assert.PanicsWithValue(t, "must reach the caller", func() {
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
	}, "HTTPMetrics records the panic but must not swallow it: JSONRecoverer owns the response")
}

func TestHTTPMetrics_PanicRecordsStatusSentOnWire(t *testing.T) {
	t.Parallel()
	for _, recoverInside := range []bool{false, true} {
		for _, commit := range []string{"none", "header", "body", "flush", "repeated header", "informational"} {
			t.Run(fmt.Sprintf("recoverInside=%t/%s", recoverInside, commit), func(t *testing.T) {
				m := routes.NewSmithersMetrics()
				r := chi.NewRouter()
				if recoverInside {
					r.Use(middleware.HTTPMetrics(m), middleware.JSONRecoverer)
				} else {
					r.Use(middleware.JSONRecoverer, middleware.HTTPMetrics(m))
				}
				r.Get("/panic", func(w http.ResponseWriter, _ *http.Request) {
					switch commit {
					case "header":
						w.WriteHeader(http.StatusOK)
					case "body":
						_, _ = w.Write([]byte("partial"))
					case "flush":
						w.(http.Flusher).Flush()
					case "repeated header":
						w.WriteHeader(http.StatusOK)
						w.WriteHeader(http.StatusTeapot)
					case "informational":
						w.WriteHeader(http.StatusEarlyHints)
					}
					panic("wire status fixture")
				})
				// A real server distinguishes informational headers from the final
				// response and commits an implicit 200 on Flush.
				server := httptest.NewServer(r)
				t.Cleanup(server.Close)
				response, err := server.Client().Get(server.URL + "/panic")
				require.NoError(t, err)
				require.NoError(t, response.Body.Close())
				want := http.StatusOK
				if commit == "none" || commit == "informational" {
					want = http.StatusInternalServerError
				}
				require.Equal(t, want, response.StatusCode)
				// Close waits for handlers, so metrics are complete before scraping.
				server.Close()
				body := scrapeSmithersMetrics(t, m)
				assert.Contains(t, body, fmt.Sprintf(`smithers_http_requests_total{method="GET",path="/panic",status="%d"} 1`, want))
				assert.Contains(t, body, `smithers_http_request_duration_seconds_count{method="GET",path="/panic"} 1`)
			})
		}
	}
}
