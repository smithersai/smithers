package observability

import (
	"net/http"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// NewHTTPClient returns a default outbound HTTP client instrumented with OTel.
// Callers that need a custom transport, such as SSRF-safe webhook delivery,
// should keep their transport and wrap it explicitly only when that preserves
// their security invariants.
func NewHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout:   timeout,
		Transport: otelhttp.NewTransport(http.DefaultTransport),
	}
}

// NewHTTPTransport wraps an outbound transport with OTel instrumentation.
func NewHTTPTransport(base http.RoundTripper) http.RoundTripper {
	if base == nil {
		base = http.DefaultTransport
	}
	return otelhttp.NewTransport(base)
}
