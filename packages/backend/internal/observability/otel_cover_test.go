package observability

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	oteltrace "go.opentelemetry.io/otel/trace"

	"github.com/smithersai/smithers/packages/backend/internal/config"
)

func TestInitInjectedExporterSetsGlobals(t *testing.T) {
	originalProvider := otel.GetTracerProvider()
	originalPropagator := otel.GetTextMapPropagator()
	defer otel.SetTracerProvider(originalProvider)
	defer otel.SetTextMapPropagator(originalPropagator)

	provider, err := InitWithExporter(context.Background(), config.ObservabilityConfig{
		CloudTraceProjectID: "coverage-project",
		TraceSampleRate:     1,
	}, tracetest.NewInMemoryExporter())
	require.NoError(t, err)
	require.NotNil(t, provider)
	t.Cleanup(func() {
		require.NoError(t, provider.Shutdown(context.Background()))
	})

	assert.Same(t, provider, otel.GetTracerProvider())

	propagator := otel.GetTextMapPropagator()
	require.NotNil(t, propagator)
	carrier := propagation.MapCarrier{
		"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		"baggage":     "customer=smithers",
	}
	ctx := propagator.Extract(context.Background(), carrier)
	assert.True(t, oteltrace.SpanContextFromContext(ctx).IsValid())
	assert.Equal(t, "smithers", baggage.FromContext(ctx).Member("customer").Value())
}

func TestInitCloudExporterRequiresInjection(t *testing.T) {
	provider, err := Init(context.Background(), config.ObservabilityConfig{OTelExporter: "cloudtrace", CloudTraceProjectID: "project"})
	require.ErrorContains(t, err, "deployment-provided trace exporter")
	assert.Nil(t, provider)
}
