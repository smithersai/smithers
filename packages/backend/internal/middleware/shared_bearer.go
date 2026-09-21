package middleware

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// RequireSharedBearerToken requires requests to have an Authorization header with a Bearer token
// matching the expected token exactly. This is used for internal server-to-server callbacks
// (e.g., repo-host calling Go API).
//
// The refusal is the standard envelope, not http.Error's text/plain. One of
// the routes behind this gate is the Worker-only GitHub token exchange, and
// the Cloudflare Worker in front of plue classifies a refusal by reading the
// first 240 bytes of the body — "Unauthorized\n" told it nothing at all.
//
// Every arm answers 401 with the same sentence on purpose: which of the four
// conditions fired is not something an unauthenticated caller gets to learn.
func RequireSharedBearerToken(expectedToken string) func(http.Handler) http.Handler {
	deny := func(w http.ResponseWriter) {
		errors.WriteError(w, errors.Unauthorized("this endpoint requires its shared bearer token"))
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if expectedToken == "" {
				// Fail safe: if no token is configured, reject all requests.
				deny(w)
				return
			}

			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				deny(w)
				return
			}

			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
				deny(w)
				return
			}

			token := parts[1]
			if subtle.ConstantTimeCompare([]byte(token), []byte(expectedToken)) != 1 {
				deny(w)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
