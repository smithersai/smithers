// Package middleware: feature flag gating.
//
// Ticket 12 — feature-flag gate all non-MVP routes.
//
// FeatureFlagGate returns a middleware that short-circuits the request with
// HTTP 403 + Gitea-compatible APIError JSON ({"message":"feature not
// available"}) when the supplied predicate evaluates to false at request
// time. Predicates are closures over a *config.Config (or any struct), so the
// middleware works for any boolean field without leaking config types into
// callers.
//
// The flag is read on every request — flipping the underlying config (in
// tests, or via a future hot-reload) takes effect immediately. There is no
// caching layer here on purpose: the cost of one struct field read per
// request is negligible, and a stale-cache bug on a security gate would be
// far worse.
//
// At mount time, callers wrap a route family like:
//
//	flag := middleware.FeatureFlagGate(func() bool { return cfg.FeatureFlags.Issues })
//	r.With(append(readRepo, flag)...).Get("/repos/{owner}/{repo}/issues", h.ListIssues)
//
// or, for whole sub-routers:
//
//	r.Route("/search", func(r chi.Router) {
//	    r.Use(middleware.FeatureFlagGate(func() bool { return cfg.FeatureFlags.Search }))
//	    ...
//	})
package middleware

import (
	"net/http"

	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// featureNotAvailableMessage is the exact body string required by ticket 12's
// acceptance criteria. Clients branch on this message; do not change it.
const featureNotAvailableMessage = "feature not available"

// FeatureFlagGate returns a middleware that calls enabled() on each request
// and:
//   - if enabled() returns true, forwards the request to next.
//   - if enabled() returns false, writes a 403 + APIError JSON body
//     ({"message":"feature not available"}) and stops the chain.
//
// enabled MUST be safe to call concurrently. The typical pattern is a closure
// over a *config.Config field, which is read-only after Load.
//
// Returns nil-safe behavior: if enabled is nil, the middleware always denies
// (fail-closed). Operators or wiring code that pass a nil predicate are
// almost certainly buggy, and a 403 surfaces it immediately instead of
// silently exposing the route.
func FeatureFlagGate(enabled func() bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if enabled == nil || !enabled() {
				apierrors.WriteError(w, apierrors.Forbidden(featureNotAvailableMessage))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
