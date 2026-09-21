package middleware

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type observationTestMetrics struct {
	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
}

func (m observationTestMetrics) RequestsTotal() *prometheus.CounterVec            { return m.requests }
func (m observationTestMetrics) RequestDurationSeconds() *prometheus.HistogramVec { return m.duration }

func TestRequestObservabilityPreservesRoutingAndAttributionWithoutCredentials(t *testing.T) {
	for _, secret := range []string{"smithers_desk_sensitive", "smithers-canary-webhook.sensitive"} {
		t.Run(secret[:13], func(t *testing.T) {
			exporter := tracetest.NewInMemoryExporter()
			provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
			defer provider.Shutdown(t.Context())
			var logs bytes.Buffer
			metrics := observationTestMetrics{
				requests: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "test_requests"}, []string{"method", "path", "status"}),
				duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "test_duration"}, []string{"method", "path"}),
			}
			router := chi.NewRouter()
			router.Use(HTTPTracing("test", otelhttp.WithTracerProvider(provider)))
			router.Use(StructuredLogger(slog.New(slog.NewJSONHandler(&logs, nil))))
			router.Use(HTTPMetrics(metrics))
			router.Use(JSONRecoverer)
			router.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					ctx := ContextWithAuthInfo(r.Context(), &AuthInfo{User: &db.User{ID: 42}})
					next.ServeHTTP(w, r.WithContext(ctx))
				})
			})
			router.Get("/desktop/{token}/vnc", func(w http.ResponseWriter, r *http.Request) {
				if chi.URLParam(r, "token") != secret || r.URL.Query().Get("ticket") != "query-secret" {
					t.Error("instrumentation changed the request received by the handler")
				}
				if !trace.SpanFromContext(r.Context()).SpanContext().IsValid() {
					t.Error("handler lost the incoming span")
				}
				panic("test handler failure")
			})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest("GET", "/desktop/"+secret+"/vnc?ticket=query-secret", nil))
			if response.Code != 500 || testutil.ToFloat64(metrics.requests.WithLabelValues("GET", "/desktop/{token}/vnc", "500")) != 1 {
				t.Fatal("recovered panic was not recorded as a 500")
			}
			var record struct {
				Labels map[string]string `json:"labels"`
			}
			if err := json.Unmarshal(logs.Bytes(), &record); err != nil || record.Labels["user_id"] != "42" {
				t.Fatalf("request log lost authenticated user: %s", logs.String())
			}
			spans := exporter.GetSpans()
			if len(spans) != 1 {
				t.Fatalf("spans = %d", len(spans))
			}
			telemetry := logs.String() + fmt.Sprint(spans[0].Attributes) + spans[0].Name
			if strings.Contains(telemetry, secret) || strings.Contains(telemetry, "query-secret") {
				t.Fatal("request credentials reached logs or span attributes")
			}
		})
	}
}
