package observability

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/propagation"
	oteltrace "go.opentelemetry.io/otel/trace"

	"github.com/smithersai/smithers/packages/backend/internal/config"
)

func TestOtel_Cov_InitWithFakeADCSetsGlobals(t *testing.T) {
	originalProvider := otel.GetTracerProvider()
	originalPropagator := otel.GetTextMapPropagator()
	defer otel.SetTracerProvider(originalProvider)
	defer otel.SetTextMapPropagator(originalPropagator)

	credentialsPath := otelCovWriteFakeADCCredentials(t)
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", credentialsPath)

	provider, err := Init(context.Background(), config.ObservabilityConfig{
		CloudTraceProjectID: "coverage-project",
		TraceSampleRate:     1,
	})
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

func TestOtel_Cov_InitExporterFailureWrapsError(t *testing.T) {
	credentialsPath := filepath.Join(t.TempDir(), "invalid-adc.json")
	require.NoError(t, os.WriteFile(credentialsPath, []byte(`{"type":`), 0o600))
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", credentialsPath)

	provider, err := Init(context.Background(), config.ObservabilityConfig{
		CloudTraceProjectID: "coverage-project",
		TraceSampleRate:     0.5,
	})

	require.Error(t, err)
	assert.Nil(t, provider)
	assert.ErrorContains(t, err, "failed to create Cloud Trace exporter")
}

func otelCovWriteFakeADCCredentials(t *testing.T) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "adc.json")
	credentials := `{
		"type": "authorized_user",
		"client_id": "coverage-client-id.apps.googleusercontent.com",
		"client_secret": "coverage-client-secret",
		"refresh_token": "coverage-refresh-token"
	}`
	require.NoError(t, os.WriteFile(path, []byte(credentials), 0o600))
	return path
}
