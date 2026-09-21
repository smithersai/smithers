package routes

import (
	"log/slog"
	"net/http"
	"strings"
)

// TelemetryHandler handles POST /api/telemetry/errors.
// No authentication required. Always returns 204 No Content.
type TelemetryHandler struct {
	Metrics *SmithersMetrics
}

// ClientErrorReport is the JSON body of a client error telemetry report.
type ClientErrorReport struct {
	Client  string             `json:"client"`
	Version string             `json:"version"`
	Error   ClientErrorDetail  `json:"error"`
	Context ClientErrorContext `json:"context"`
}

// ClientErrorDetail describes the error itself.
type ClientErrorDetail struct {
	Message string `json:"message"`
	Stack   string `json:"stack"`
	Type    string `json:"type"`
}

// ClientErrorContext provides environmental context for the error.
type ClientErrorContext struct {
	URL       string `json:"url"`
	UserAgent string `json:"user_agent"`
	UserID    int64  `json:"user_id,omitempty"`
	Username  string `json:"username,omitempty"`
	Command   string `json:"command,omitempty"`
	OS        string `json:"os,omitempty"`
	Arch      string `json:"arch,omitempty"`
}

const (
	maxErrorMessageLen = 512
	maxErrorStackLen   = 4096
	maxErrorTypeLen    = 128

	clientErrorTypeOther = "other"
)

func clientErrorTypeLabel(raw string) string {
	trimmed := strings.TrimSpace(raw)
	switch trimmed {
	case "AbortError",
		"AggregateError",
		"EvalError",
		"Error",
		"NetworkError",
		"Panic",
		"RangeError",
		"ReferenceError",
		"SyntaxError",
		"TypeError",
		"URIError":
		return trimmed
	default:
		return clientErrorTypeOther
	}
}

// PostClientError handles POST /api/telemetry/errors.
func (h *TelemetryHandler) PostClientError(w http.ResponseWriter, r *http.Request) {
	var report ClientErrorReport
	if err := decodeJSONBodyError(w, r, &report); err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Validate client field.
	if report.Client != "web" && report.Client != "cli" {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Truncate fields to prevent log bloat.
	if len(report.Error.Message) > maxErrorMessageLen {
		report.Error.Message = report.Error.Message[:maxErrorMessageLen]
	}
	if len(report.Error.Stack) > maxErrorStackLen {
		report.Error.Stack = report.Error.Stack[:maxErrorStackLen]
	}
	if len(report.Error.Type) > maxErrorTypeLen {
		report.Error.Type = report.Error.Type[:maxErrorTypeLen]
	}

	errorTypeLabel := clientErrorTypeLabel(report.Error.Type)

	slog.Warn("client error",
		"client", report.Client,
		"version", report.Version,
		"error_type", report.Error.Type,
		"error_message", report.Error.Message,
		"error_stack", report.Error.Stack,
		"url", report.Context.URL,
		"user_agent", report.Context.UserAgent,
		"user_id", report.Context.UserID,
		"username", report.Context.Username,
		"command", report.Context.Command,
		"os", report.Context.OS,
		"arch", report.Context.Arch,
	)

	// Increment Prometheus counter.
	if h.Metrics != nil {
		h.Metrics.ClientErrorsTotal.WithLabelValues(report.Client, errorTypeLabel).Inc()
	}

	w.WriteHeader(http.StatusNoContent)
}
