// Package telemetry exposes the shared redacted instrumentation and logging pipeline.
package telemetry

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	"go.opentelemetry.io/otel/sdk/trace"
	"io"
	"log/slog"
	"net/http"
	"time"
)

type Config = config.ObservabilityConfig

func NewHTTPClient(timeout time.Duration) *http.Client { return observability.NewHTTPClient(timeout) }
func NewHTTPTransport(base http.RoundTripper) http.RoundTripper {
	return observability.NewHTTPTransport(base)
}
func NewJSONHandler(w io.Writer, level slog.Leveler) slog.Handler {
	return middleware.NewGCPJSONHandler(w, level)
}
func InitWithExporter(ctx context.Context, cfg Config, exporter trace.SpanExporter) (*trace.TracerProvider, error) {
	return observability.InitWithExporter(ctx, cfg, exporter)
}
