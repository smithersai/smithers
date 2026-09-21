// Package observability provides shared OpenTelemetry initialization for
// Smithers services (API server, repo-host). It wires a Google Cloud Trace
// exporter, a sample-rate-based sampler, and W3C TraceContext + Baggage
// propagation.
package observability

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"strings"

	cloudtrace "github.com/GoogleCloudPlatform/opentelemetry-operations-go/exporter/trace"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/trace"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// BuildTraceSampler creates a trace sampler based on the configured sample rate.
// Sample rate of 0.0 = never sample, 1.0 = always sample. Values in between
// honor an incoming W3C traceparent sampling decision (ParentBased) and fall
// back to TraceIDRatioBased for root spans, so an operator tool that sends a
// sampled traceparent (the Observe playground) always gets its trace exported
// while organic traffic stays at the configured ratio.
func BuildTraceSampler(sampleRate float64) trace.Sampler {
	switch {
	case sampleRate <= 0.0:
		return trace.NeverSample()
	case sampleRate >= 1.0:
		return trace.AlwaysSample()
	default:
		return trace.ParentBased(trace.TraceIDRatioBased(sampleRate))
	}
}

// BuildTextMapPropagator creates a composite text map propagator that supports
// W3C Trace Context and W3C Baggage propagation.
func BuildTextMapPropagator() propagation.TextMapPropagator {
	return propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	)
}

func traceExporterName(cfg config.ObservabilityConfig) string {
	name := strings.ToLower(strings.TrimSpace(cfg.OTelExporter))
	if name == "" {
		return "cloudtrace"
	}
	return name
}

func buildTraceExporter(ctx context.Context, cfg config.ObservabilityConfig) (trace.SpanExporter, string, error) {
	switch exporterName := traceExporterName(cfg); exporterName {
	case "cloudtrace":
		if strings.TrimSpace(cfg.CloudTraceProjectID) == "" {
			return nil, exporterName, nil
		}
		exporter, err := cloudtrace.New(
			cloudtrace.WithProjectID(cfg.CloudTraceProjectID),
		)
		if err != nil {
			return nil, exporterName, fmt.Errorf("failed to create Cloud Trace exporter: %w", err)
		}
		return exporter, exporterName, nil
	case "otlp":
		endpoint := strings.TrimSpace(cfg.OTLPEndpoint)
		if endpoint == "" {
			return nil, exporterName, fmt.Errorf("SMITHERS_OTEL_EXPORTER=otlp requires SMITHERS_OTEL_EXPORTER_OTLP_ENDPOINT")
		}
		exporter, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(endpoint))
		if err != nil {
			return nil, exporterName, fmt.Errorf("failed to create OTLP trace exporter: %w", err)
		}
		return exporter, exporterName, nil
	default:
		return nil, exporterName, fmt.Errorf("unsupported SMITHERS_OTEL_EXPORTER %q (valid: cloudtrace, otlp)", exporterName)
	}
}

// Init sets up the OpenTelemetry SDK with the configured trace exporter.
// Returns the trace provider, or nil if tracing is disabled.
// The returned provider's Shutdown must be called on application exit to flush spans.
func Init(ctx context.Context, cfg config.ObservabilityConfig) (*trace.TracerProvider, error) {
	exporter, exporterName, err := buildTraceExporter(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if exporter == nil {
		slog.Info("OpenTelemetry: tracing disabled", "exporter", exporterName)
		return nil, nil
	}

	tp := NewTracerProvider(exporter, cfg.TraceSampleRate)

	// Set the global tracer provider and propagator
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(BuildTextMapPropagator())

	slog.Info(
		"OpenTelemetry initialized",
		"exporter", exporterName,
		"project", cfg.CloudTraceProjectID,
		"sample_rate", cfg.TraceSampleRate,
	)

	return tp, nil
}

// NewTracerProvider builds the tracer provider Init installs globally: the
// configured sampler, URL redaction, and batching export pipeline.
func NewTracerProvider(exporter trace.SpanExporter, sampleRate float64) *trace.TracerProvider {
	return trace.NewTracerProvider(
		trace.WithSpanProcessor(urlCredentialRedactor{}),
		trace.WithBatcher(urlRedactingExporter{SpanExporter: exporter}),
		trace.WithSampler(BuildTraceSampler(sampleRate)),
	)
}

// otelhttp server instrumentation supplies URL attributes at span start.
// Rewrite them before any subsequent processor can observe the credential.
type urlCredentialRedactor struct{}

func (urlCredentialRedactor) OnStart(_ context.Context, span trace.ReadWriteSpan) {
	span.SetAttributes(redactURLAttributes(span.Attributes())...)
}

func (urlCredentialRedactor) OnEnd(trace.ReadOnlySpan)         {}
func (urlCredentialRedactor) Shutdown(context.Context) error   { return nil }
func (urlCredentialRedactor) ForceFlush(context.Context) error { return nil }

// otelhttp clients attach url.full after Start. Redact the final snapshot too,
// without mutating the immutable span shared with other processors.
type urlRedactingExporter struct{ trace.SpanExporter }

func (e urlRedactingExporter) ExportSpans(ctx context.Context, spans []trace.ReadOnlySpan) error {
	clean := make([]trace.ReadOnlySpan, len(spans))
	for i, span := range spans {
		clean[i] = urlRedactedSpan{ReadOnlySpan: span, attrs: redactURLAttributes(span.Attributes())}
	}
	return e.SpanExporter.ExportSpans(ctx, clean)
}

type urlRedactedSpan struct {
	trace.ReadOnlySpan
	attrs []attribute.KeyValue
}

func (s urlRedactedSpan) Attributes() []attribute.KeyValue { return s.attrs }

func redactURLAttributes(attrs []attribute.KeyValue) []attribute.KeyValue {
	var clean []attribute.KeyValue
	for i, attr := range attrs {
		if attr.Value.Type() != attribute.STRING {
			continue
		}
		value := attr.Value.AsString()
		var redacted string
		switch attr.Key {
		case "url.path":
			redacted = middleware.RedactSecretPath(value)
		case "url.query":
			redacted = redactSecretQuery(value)
		case "url.full", "http.target":
			parsed, err := url.Parse(value)
			if err != nil {
				path, query, hasQuery := strings.Cut(value, "?")
				redacted = middleware.RedactSecretPath(path)
				if hasQuery {
					redacted += "?" + redactSecretQuery(query)
				}
			} else {
				path := middleware.RedactSecretPath(parsed.Path)
				if path != parsed.Path {
					parsed.Path, parsed.RawPath = path, ""
				}
				parsed.RawQuery = redactSecretQuery(parsed.RawQuery)
				redacted = parsed.String()
			}
		default:
			continue
		}
		if redacted != value {
			if clean == nil {
				clean = append([]attribute.KeyValue(nil), attrs...)
			}
			clean[i] = attribute.String(string(attr.Key), redacted)
		}
	}
	if clean == nil {
		return attrs
	}
	return clean
}

// Preserve query order and escaping while stripping the noVNC password and
// token-bearing websockify path, including percent-encoded parameter names.
func redactSecretQuery(query string) string {
	pairs := strings.Split(query, "&")
	for i, pair := range pairs {
		key, _, hasValue := strings.Cut(pair, "=")
		decoded, err := url.QueryUnescape(key)
		if err == nil && hasValue && (strings.EqualFold(decoded, "password") || strings.EqualFold(decoded, "path")) {
			pairs[i] = key + "=REDACTED"
		}
	}
	return strings.Join(pairs, "&")
}
