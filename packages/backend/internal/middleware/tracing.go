package middleware

import (
	"context"
	"net/http"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

type originalTraceRequestKey struct{}

// HTTPTracing lets instrumentation see a sanitized URL while routing and
// authentication receive the original request with the resulting span context.
// Removing credentials after a span starts is too late: HTTP instrumentation
// records URL attributes before invoking the handler.
func HTTPTracing(operation string, options ...otelhttp.Option) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		traced := otelhttp.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			original := r.Context().Value(originalTraceRequestKey{}).(*http.Request)
			restored := original.WithContext(r.Context())
			restored.Body = r.Body // Preserve the instrumented request-body reader.
			next.ServeHTTP(w, restored)
		}), operation, options...)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			observed := r.Clone(context.WithValue(r.Context(), originalTraceRequestKey{}, r))
			observed.URL.Path = redactSecretPathSegments(r.URL.Path)
			observed.URL.RawPath = ""
			observed.URL.RawQuery = ""
			observed.URL.User = nil
			observed.RequestURI = observed.URL.EscapedPath()
			traced.ServeHTTP(w, observed)
		})
	}
}
