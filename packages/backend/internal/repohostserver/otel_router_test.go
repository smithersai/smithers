package repohostserver

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/smithersai/smithers/packages/backend/internal/observability"
)

// setupTestTracing installs an always-sampling tracer provider with an
// in-memory span recorder plus the W3C propagator globally, restoring the
// previous globals on cleanup. Returns the recorder for assertions.
func setupTestTracing(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	prevTP := otel.GetTracerProvider()
	prevProp := otel.GetTextMapPropagator()

	recorder := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithSpanProcessor(recorder),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(observability.BuildTextMapPropagator())

	t.Cleanup(func() {
		otel.SetTracerProvider(prevTP)
		otel.SetTextMapPropagator(prevProp)
	})
	return recorder
}

// TestRouterPropagatesIncomingTraceContext verifies that the otelhttp
// middleware extracts an incoming traceparent header (as sent by the API's
// instrumented repohost client) and continues the trace: the server span
// created for the request shares the caller's trace ID and is parented to
// the caller's span.
func TestRouterPropagatesIncomingTraceContext(t *testing.T) {
	recorder := setupTestTracing(t)

	srv := newTestServer(t)
	handler := srv.Handler()

	const incomingTraceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	const incomingSpanID = "00f067aa0ba902b7"

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("traceparent", "00-"+incomingTraceID+"-"+incomingSpanID+"-01")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 from /health, got %d", rec.Code)
	}

	spans := recorder.Ended()
	if len(spans) == 0 {
		t.Fatal("expected the otelhttp middleware to record a server span")
	}
	span := spans[0]
	if got := span.SpanContext().TraceID().String(); got != incomingTraceID {
		t.Errorf("server span trace ID = %s, want incoming trace ID %s", got, incomingTraceID)
	}
	if got := span.Parent().SpanID().String(); got != incomingSpanID {
		t.Errorf("server span parent span ID = %s, want incoming span ID %s", got, incomingSpanID)
	}
	if !span.Parent().IsRemote() {
		t.Error("server span parent should be marked remote (extracted from traceparent)")
	}
}

// TestRouterStartsNewTraceWithoutTraceparent verifies requests without a
// traceparent header still get a valid root span (no incoming parent).
func TestRouterStartsNewTraceWithoutTraceparent(t *testing.T) {
	recorder := setupTestTracing(t)

	srv := newTestServer(t)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 from /health, got %d", rec.Code)
	}

	spans := recorder.Ended()
	if len(spans) == 0 {
		t.Fatal("expected the otelhttp middleware to record a server span")
	}
	span := spans[0]
	if !span.SpanContext().TraceID().IsValid() {
		t.Error("expected a valid trace ID on the root server span")
	}
	if span.Parent().IsValid() {
		t.Errorf("expected no parent span, got %s", span.Parent().SpanID())
	}
}
