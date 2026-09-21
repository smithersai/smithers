package middleware_test

// Regression tests promoted from reviews/release-2026-09-13/evidence/middleware_repro.go.txt.
import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

func TestReleaseReviewPanicIsCounted(t *testing.T) {
	t.Parallel()

	metrics := routes.NewSmithersMetrics()
	router := chi.NewRouter()
	router.Use(middleware.JSONRecoverer) // same order as cmd/server/router.go
	router.Use(middleware.HTTPMetrics(metrics))
	router.Get("/api/review-panic", func(http.ResponseWriter, *http.Request) { panic("review fixture") })

	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/review-panic", nil))
	require.Equal(t, http.StatusInternalServerError, response.Code)

	count := testutil.ToFloat64(metrics.RequestsTotal().WithLabelValues("GET", "/api/review-panic", "500"))
	assert.Equal(t, float64(1), count, "500 response was not recorded in smithers_http_requests_total")
}

func TestReleaseReviewAuthenticatedRequestLogHasUser(t *testing.T) {
	t.Parallel()

	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	handler := middleware.StructuredLogger(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// AuthLoader passes a new request with this context to inner handlers.
		r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &db.User{ID: 42}}))
		require.Equal(t, int64(42), middleware.UserFromContext(r.Context()).ID, "fixture auth failed")
		w.WriteHeader(http.StatusOK)
	}))

	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/user", nil))
	assert.Contains(t, output.String(), `"user_id":"42"`, "authenticated request missing user_id")
}

func TestReleaseReviewDesktopTokenIsRedacted(t *testing.T) {
	t.Parallel()

	token := "smithers_desk_review_synthetic_token"
	path := "/api/workspaces/review/desktop/" + token + "/vnc.html"

	var output bytes.Buffer
	// The production provider (observability.Init builds the same one): the
	// redaction lives in its span pipeline, not in otelhttp, so the exported
	// spans are what an operator would see in Cloud Trace.
	exporter := tracetest.NewInMemoryExporter()
	provider := observability.NewTracerProvider(exporter, 1.0)
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })

	handler := otelhttp.NewMiddleware("smithers-server", otelhttp.WithTracerProvider(provider))(
		middleware.StructuredLogger(slog.New(slog.NewJSONHandler(&output, nil)))(
			http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }),
		),
	)
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))

	assert.NotContains(t, output.String(), token, "request log contains desktop bearer token")
	require.NoError(t, provider.ForceFlush(context.Background()))
	spans := exporter.GetSpans()
	require.NotEmpty(t, spans, "otelhttp must export the server span")
	for _, span := range spans {
		for _, attr := range span.Attributes {
			assert.False(t, strings.Contains(attr.Value.String(), token),
				"trace attribute %s contains desktop bearer token", attr.Key)
		}
	}
}
