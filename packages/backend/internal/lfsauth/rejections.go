package lfsauth

import (
	"errors"
	"log/slog"
	"net/http"

	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus"
)

// Verify failure classes. Each keeps the message callers already saw; the
// sentinel lets operators tell clock skew or a secret mismatch from a probe.
var (
	ErrNotConfigured = errors.New("lfs auth manager is not configured")
	ErrMalformed     = errors.New("invalid lfs auth token")
	ErrSignature     = errors.New("invalid lfs auth token signature")
	ErrInvalidClaims = errors.New("invalid lfs auth claims")
	ErrNotYetValid   = errors.New("lfs auth token is not yet valid")
	ErrExpired       = errors.New("lfs auth token has expired")
)

const (
	reasonNotConfigured = "not_configured"
	reasonMalformed     = "malformed"
	reasonSignature     = "signature"
	reasonClaims        = "claims"
	reasonNotYetValid   = "not_yet_valid"
	reasonExpired       = "expired"
	reasonPurpose       = "purpose"
)

// Rejections counts LFS credentials HTTPMiddleware refused, by failure class.
// compose registers it on the Smithers registry.
var Rejections = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "smithers_lfs_auth_rejections_total",
	Help: "LFS credentials refused by the API, by failure class.",
}, []string{"reason"})

func rejectionReason(err error) string {
	switch {
	case errors.Is(err, ErrNotConfigured):
		return reasonNotConfigured
	case errors.Is(err, ErrSignature):
		return reasonSignature
	case errors.Is(err, ErrInvalidClaims):
		return reasonClaims
	case errors.Is(err, ErrNotYetValid):
		return reasonNotYetValid
	case errors.Is(err, ErrExpired):
		return reasonExpired
	default:
		return reasonMalformed
	}
}

// reject logs and counts a refused LFS credential, then answers 401. It never
// logs the credential.
func reject(w http.ResponseWriter, r *http.Request, reason string) {
	Rejections.WithLabelValues(reason).Inc()
	slog.WarnContext(r.Context(), "lfs credential rejected",
		"reason", reason,
		"request_id", chimiddleware.GetReqID(r.Context()),
		"method", r.Method,
		"path", r.URL.Path,
	)
	writeUnauthorized(w)
}
