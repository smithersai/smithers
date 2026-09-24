package middleware

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// AuthLoaderFailures counts credential-store failures seen while loading
// request auth, by stage. compose registers it on the Smithers registry.
var AuthLoaderFailures = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "smithers_auth_loader_failures_total",
	Help: "Credential-store failures while loading request auth, by stage.",
}, []string{"stage"})

// recordAuthLoaderFailure logs and counts a credential-store failure. It never
// logs the credential itself.
func recordAuthLoaderFailure(r *http.Request, stage string, err error) {
	AuthLoaderFailures.WithLabelValues(stage).Inc()
	LoggerFromContext(r.Context()).Warn("auth loader store failure",
		"stage", stage,
		"request_id", RequestIDFromContext(r.Context()),
		"error", err,
	)
}

// writeAuthStoreUnavailable answers a request whose credential could not be
// checked because the store failed. Serving it as anonymous would log every
// signed-in user out during a database failover and blame them for it.
func writeAuthStoreUnavailable(w http.ResponseWriter, r *http.Request, stage string, err error) {
	recordAuthLoaderFailure(r, stage, err)
	errors.WriteError(w, errors.New(errors.CodeServiceUnavailable, "authentication is temporarily unavailable"))
}
