package middleware

import (
	"bufio"
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"go.opentelemetry.io/otel/trace"
)

// ParseSlogLevel parses a string log level into slog.Level.
// Supported levels: debug, info, warn/warning, error, critical.
// Defaults to info for invalid or empty input.
func ParseSlogLevel(raw string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "debug":
		return slog.LevelDebug
	case "info":
		return slog.LevelInfo
	case "warn", "warning":
		return slog.LevelWarn
	case "error", "critical":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// MapSeverity maps a slog.Level to a GCP-compatible severity string.
// GCP Cloud Logging uses: DEBUG, INFO, WARNING, ERROR, CRITICAL.
func MapSeverity(level slog.Level) string {
	switch {
	case level <= slog.LevelDebug:
		return "DEBUG"
	case level <= slog.LevelInfo:
		return "INFO"
	case level <= slog.LevelWarn:
		return "WARNING"
	case level <= slog.LevelError:
		return "ERROR"
	default:
		return "ERROR"
	}
}

// TraceFieldsFromContext extracts trace_id and span_id from the OpenTelemetry
// span context in the provided context. Returns empty strings if no valid
// span context exists.
func TraceFieldsFromContext(ctx context.Context) (traceID string, spanID string) {
	spanContext := trace.SpanContextFromContext(ctx)
	if !spanContext.IsValid() {
		return "", ""
	}
	return spanContext.TraceID().String(), spanContext.SpanID().String()
}

// gcpHandler is a custom slog.Handler that emits GCP-compatible JSON logs.
// It maps slog's "level" field to GCP's "severity" field.
type gcpHandler struct {
	handler slog.Handler
	level   slog.Leveler
	attrs   []slog.Attr
	groups  []string
}

// NewGCPJSONHandler creates a new slog.Handler that emits GCP-compatible JSON logs.
// The handler maps slog levels to GCP severity and includes structured fields
// compatible with Google Cloud Logging.
func NewGCPJSONHandler(w io.Writer, level slog.Leveler) slog.Handler {
	if level == nil {
		level = slog.LevelInfo
	}

	// Create the base JSON handler with our custom options
	opts := &slog.HandlerOptions{
		Level:       level,
		ReplaceAttr: gcpReplaceAttr,
	}

	return &gcpHandler{
		handler: slog.NewJSONHandler(w, opts),
		level:   level,
	}
}

// gcpReplaceAttr replaces slog's default attributes with GCP-compatible ones.
func gcpReplaceAttr(groups []string, a slog.Attr) slog.Attr {
	// Rename "level" to "severity" for GCP compatibility
	if a.Key == slog.LevelKey {
		level := a.Value.Any().(slog.Level)
		return slog.String("severity", MapSeverity(level))
	}

	// Rename "msg" to "message" for GCP compatibility
	if a.Key == slog.MessageKey {
		return slog.String("message", a.Value.String())
	}

	// Keep "time" as-is (GCP accepts it)
	if a.Key == slog.TimeKey {
		return a
	}

	return a
}

// Enabled reports whether the handler handles records at the given level.
func (h *gcpHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.handler.Enabled(ctx, level)
}

// Handle processes a log record.
func (h *gcpHandler) Handle(ctx context.Context, r slog.Record) error {
	return h.handler.Handle(ctx, r)
}

// WithAttrs returns a new handler with the given attributes.
func (h *gcpHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &gcpHandler{
		handler: h.handler.WithAttrs(attrs),
		level:   h.level,
		attrs:   append(h.attrs, attrs...),
		groups:  h.groups,
	}
}

// WithGroup returns a new handler with the given group name.
func (h *gcpHandler) WithGroup(name string) slog.Handler {
	return &gcpHandler{
		handler: h.handler.WithGroup(name),
		level:   h.level,
		attrs:   h.attrs,
		groups:  append(h.groups, name),
	}
}

// NewServerLogger creates a new slog.Logger configured for server logging.
// The logger outputs GCP-compatible JSON format with the specified minimum log level.
func NewServerLogger(w io.Writer, level string) *slog.Logger {
	slogLevel := ParseSlogLevel(level)
	handler := NewGCPJSONHandler(w, slogLevel)
	return slog.New(handler)
}

// loggingResponseWriter wraps an http.ResponseWriter to capture the status code
// and response size for logging purposes.
type loggingResponseWriter struct {
	http.ResponseWriter
	statusCode   int
	bytesWritten int
}

type loggingHijacker struct {
	*loggingResponseWriter
	hijacker http.Hijacker
}

// newLoggingResponseWriter creates a new loggingResponseWriter that wraps the
// provided ResponseWriter.
func newLoggingResponseWriter(w http.ResponseWriter) (http.ResponseWriter, *loggingResponseWriter) {
	lrw := &loggingResponseWriter{
		ResponseWriter: w,
		statusCode:     http.StatusOK,
		bytesWritten:   0,
	}

	if h, ok := w.(http.Hijacker); ok {
		return &loggingHijacker{loggingResponseWriter: lrw, hijacker: h}, lrw
	}

	return lrw, lrw
}

// WriteHeader captures the status code before delegating to the wrapped writer.
func (lrw *loggingResponseWriter) WriteHeader(code int) {
	lrw.statusCode = code
	lrw.ResponseWriter.WriteHeader(code)
}

// Write captures the number of bytes written before delegating to the wrapped writer.
func (lrw *loggingResponseWriter) Write(b []byte) (int, error) {
	n, err := lrw.ResponseWriter.Write(b)
	lrw.bytesWritten += n
	return n, err
}

// Unwrap exposes the wrapped writer so http.ResponseController can reach the
// underlying connection (e.g. to arm per-request read/write deadlines).
func (lrw *loggingResponseWriter) Unwrap() http.ResponseWriter {
	return lrw.ResponseWriter
}

// Flush implements http.Flusher to support streaming responses (e.g., SSE).
func (lrw *loggingResponseWriter) Flush() {
	if f, ok := lrw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (lrw *loggingHijacker) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return lrw.hijacker.Hijack()
}

type requestLogIdentityKey struct{}
type requestLogIdentity struct{ userID atomic.Int64 }

// StructuredLogger returns a middleware that logs HTTP requests using structured
// JSON logging compatible with Google Cloud Logging. It captures:
//   - HTTP method, URL, status code, response size, and latency
//   - Request ID from chi middleware
//   - User ID when the request is authenticated
//   - Trace ID and Span ID from OpenTelemetry context
//
// Example log output:
//
//	{
//	  "severity": "INFO",
//	  "message": "http request",
//	  "time": "2024-01-01T00:00:00Z",
//	  "httpRequest": {
//	    "requestMethod": "GET",
//	    "requestUrl": "/api/repos",
//	    "status": 200,
//	    "latency": "5.234ms",
//	    "remoteIp": "192.168.1.1"
//	  },
//	  "labels": {
//	    "request_id": "req-123",
//	    "user_id": "42"
//	  },
//	  "trace_id": "abc123...",
//	  "span_id": "def456..."
//	}
func StructuredLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			// Later middlewares (AuthLoader, SSETicketAuth, RevocationGuard)
			// pass a derived context downstream that this handler never sees,
			// so they report the principal through this record instead. It
			// starts from whatever authenticated the request before the
			// logger ran, and the last write wins: a refused request logs no
			// user, a re-authenticated one logs the final principal.
			identity := &requestLogIdentity{}
			if authInfo := AuthInfoFromContext(r.Context()); authInfo != nil && authInfo.User != nil {
				identity.userID.Store(authInfo.User.ID)
			}
			r = r.WithContext(context.WithValue(r.Context(), requestLogIdentityKey{}, identity))

			// Wrap the response writer to capture status code
			wrapped, lrw := newLoggingResponseWriter(w)

			// Process the request
			next.ServeHTTP(wrapped, r)

			// Calculate latency
			latency := time.Since(start)

			// Build log attributes
			attrs := buildLogAttrs(r, lrw, latency)

			// Log the request
			logger.LogAttrs(r.Context(), slog.LevelInfo, "http request", attrs...)
		})
	}
}

// secretPathTokenPrefixes lists URL path-segment prefixes that carry a bearer
// secret as part of the path itself (webhook_tokenauth-style and relay routes,
// where the secret cannot be moved into a header). Any path segment starting
// with one of these prefixes is redacted before logging so the secret never
// lands in request logs. Prefixes are matched literally, so each carries its
// own terminator: the canary token is "<prefix>.<hex>", the desktop relay
// token is "smithers_desk_<hex>".
var secretPathTokenPrefixes = []string{"smithers-canary-webhook.", "smithers_desk_"}

// redactSecretPathSegments replaces any path segment carrying a secret token
// (identified by a known prefix) with "<prefix>REDACTED", preserving the
// rest of the path (including trailing segments like "/outcome") so that log
// queries grouped by route remain usable without leaking the secret itself.
func redactSecretPathSegments(path string) string {
	segments := strings.Split(path, "/")
	for i, segment := range segments {
		for _, prefix := range secretPathTokenPrefixes {
			if strings.HasPrefix(segment, prefix) {
				segments[i] = prefix + "REDACTED"
				break
			}
		}
	}
	return strings.Join(segments, "/")
}

// RedactSecretPath is the exported form of redactSecretPathSegments for
// span-attribute redaction in internal/observability, so URL paths carry the
// same redaction in traces as in access logs.
func RedactSecretPath(path string) string {
	return redactSecretPathSegments(path)
}

// buildLogAttrs builds the slog attributes for a request log entry.
func buildLogAttrs(r *http.Request, lrw *loggingResponseWriter, latency time.Duration) []slog.Attr {
	// Get request ID from chi middleware
	requestID := middleware.GetReqID(r.Context())

	// Get trace and span IDs from OpenTelemetry context
	traceID, spanID := TraceFieldsFromContext(r.Context())

	// Build httpRequest group - convert []slog.Attr to []any for slog.Group
	httpRequestAttrs := make([]any, 0, 5)
	httpRequestAttrs = append(httpRequestAttrs,
		slog.String("requestMethod", r.Method),
		slog.String("requestUrl", redactSecretPathSegments(r.URL.Path)),
		slog.Int("status", lrw.statusCode),
		slog.String("latency", formatLatency(latency)),
	)

	// Add remote IP if available
	if remoteIP := r.RemoteAddr; remoteIP != "" {
		httpRequestAttrs = append(httpRequestAttrs, slog.String("remoteIp", remoteIPFromAddr(remoteIP)))
	}

	// Build labels group - convert to []any for slog.Group
	labelAttrs := make([]any, 0, 2)
	labelAttrs = append(labelAttrs, slog.String("request_id", requestID))

	// Add user_id for the principal the request finally ran as. The identity
	// record carries every ContextWithAuthInfo update made after the logger
	// ran; callers that build attributes without the logger's context fall
	// back to the AuthInfo in the request context.
	if identity, ok := r.Context().Value(requestLogIdentityKey{}).(*requestLogIdentity); ok {
		if id := identity.userID.Load(); id > 0 {
			labelAttrs = append(labelAttrs, slog.String("user_id", formatUserID(id)))
		}
	} else if authInfo := AuthInfoFromContext(r.Context()); authInfo != nil && authInfo.User != nil {
		labelAttrs = append(labelAttrs, slog.String("user_id", formatUserID(authInfo.User.ID)))
	}

	// Build the main attributes
	attrs := []slog.Attr{
		slog.Group("httpRequest", httpRequestAttrs...),
		slog.Group("labels", labelAttrs...),
	}

	// Add trace_id and span_id if available
	if traceID != "" {
		attrs = append(attrs, slog.String("trace_id", traceID))
	}
	if spanID != "" {
		attrs = append(attrs, slog.String("span_id", spanID))
	}

	return attrs
}

func remoteIPFromAddr(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err == nil {
		return host
	}

	addr, err := netip.ParseAddr(remoteAddr)
	if err == nil {
		return addr.String()
	}

	return remoteAddr
}

// formatLatency formats a duration as a human-readable string.
func formatLatency(d time.Duration) string {
	if d < time.Microsecond {
		return d.String()
	}
	if d < time.Millisecond {
		return d.Round(time.Microsecond).String()
	}
	if d < time.Second {
		return d.Round(time.Millisecond).String()
	}
	return d.Round(time.Millisecond).String()
}

// formatUserID formats a user ID as a string.
func formatUserID(id int64) string {
	return strconv.FormatInt(id, 10)
}

// ---------------------------------------------------------------------------
// Context-aware logging: inject a request-scoped logger into context so that
// handlers and services can log with request_id (and other correlation fields)
// automatically attached.
// ---------------------------------------------------------------------------

const loggerContextKey contextKey = "request_logger"

// InjectLogger returns middleware that creates a child *slog.Logger with the
// request's correlation IDs (request_id, trace_id, span_id, user_id) and
// stores it in the request context. Downstream code retrieves it via
// LoggerFromContext.
//
// This middleware must be placed AFTER chiMiddleware.RequestID (so the request
// ID exists) and AFTER AuthLoader (if user_id should be included).
//
// Because AuthLoader runs later in the /api route group, the injected logger
// will only contain user_id when InjectLogger itself is placed after auth.
// For the global middleware stack the logger carries request_id and trace IDs;
// user_id is added lazily by LoggerFromContext when auth info is available.
func InjectLogger(base *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			logger := base

			// Always attach request_id.
			if reqID := middleware.GetReqID(r.Context()); reqID != "" {
				logger = logger.With("request_id", reqID)
			}

			// Attach trace_id / span_id when available.
			traceID, spanID := TraceFieldsFromContext(r.Context())
			if traceID != "" {
				logger = logger.With("trace_id", traceID)
			}
			if spanID != "" {
				logger = logger.With("span_id", spanID)
			}

			ctx := context.WithValue(r.Context(), loggerContextKey, logger)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// LoggerFromContext retrieves the request-scoped logger that was stored by
// InjectLogger. If no logger is found (e.g. background goroutine), it returns
// slog.Default() so callers never get nil.
//
// The returned logger already carries request_id, trace_id, and span_id.
// If the context contains AuthInfo with a user, user_id is added on the fly.
func LoggerFromContext(ctx context.Context) *slog.Logger {
	logger, _ := ctx.Value(loggerContextKey).(*slog.Logger)
	if logger == nil {
		logger = slog.Default()
	}

	// Lazily add user_id when auth context is available (AuthLoader runs
	// after the global InjectLogger in the middleware stack).
	if authInfo := AuthInfoFromContext(ctx); authInfo != nil && authInfo.User != nil {
		logger = logger.With("user_id", formatUserID(authInfo.User.ID))
	}

	return logger
}

// LoggerWithAgentSession returns a child logger annotated with the given
// agent_session_id. Use this in agent-related handlers and services to
// correlate logs with a specific agent session.
func LoggerWithAgentSession(ctx context.Context, sessionID string) *slog.Logger {
	return LoggerFromContext(ctx).With("agent_session_id", sessionID)
}

// LoggerWithWorkflowRun returns a child logger annotated with the given
// workflow_run_id. Use this in workflow-related handlers and services to
// correlate logs with a specific workflow run.
func LoggerWithWorkflowRun(ctx context.Context, workflowRunID int64) *slog.Logger {
	return LoggerFromContext(ctx).With("workflow_run_id", workflowRunID)
}

// LoggerWithAgentSessionAndWorkflowRun returns a child logger annotated with
// both agent_session_id and workflow_run_id. Use this in agent dispatch flows
// where both correlation IDs are available.
func LoggerWithAgentSessionAndWorkflowRun(ctx context.Context, sessionID string, workflowRunID int64) *slog.Logger {
	return LoggerFromContext(ctx).With("agent_session_id", sessionID, "workflow_run_id", workflowRunID)
}

// RequestIDFromContext is a convenience wrapper around chi's GetReqID so that
// non-middleware packages (e.g. the repohost client) can extract the request
// ID from context without importing chi/middleware directly.
func RequestIDFromContext(ctx context.Context) string {
	return middleware.GetReqID(ctx)
}
