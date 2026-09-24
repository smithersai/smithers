package middleware

import (
	"net/http"
	"net/url"
	"strings"
)

// CanonicalBrowserAuthOrigin starts every interactive GitHub flow on the
// configured callback origin, before OAuth state or consent cookies are set.
// Native clients may still address the API origin; their loopback parameters
// survive this browser hop. Token APIs remain on their original endpoints.
func CanonicalBrowserAuthOrigin(callbackURL string) func(http.Handler) http.Handler {
	callback, err := url.Parse(callbackURL)
	valid := err == nil && callback.Host != "" && callback.User == nil &&
		(callback.Scheme == "https" || callback.Scheme == "http")
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			interactive := r.URL.Path == "/api/auth/github" || r.URL.Path == "/api/auth/github/cli" || r.URL.Path == "/api/oauth2/authorize"
			if r.Method != http.MethodGet || !interactive {
				next.ServeHTTP(w, r)
				return
			}
			if !valid {
				http.Error(w, "OAuth callback origin is not configured", http.StatusServiceUnavailable)
				return
			}
			scheme := "http"
			if r.TLS != nil {
				scheme = "https"
			}
			onOrigin := strings.EqualFold(r.Host, callback.Host) && scheme == callback.Scheme
			// These headers only suppress a redirect to a fixed configured origin.
			// They never select a destination or establish identity/authorization.
			// The edge replaces caller headers with its actual request origin.
			proxied := strings.EqualFold(r.Header.Get("X-Forwarded-Host"), callback.Host) && r.Header.Get("X-Forwarded-Proto") == callback.Scheme
			if onOrigin || proxied {
				next.ServeHTTP(w, r)
				return
			}
			destination := url.URL{Scheme: callback.Scheme, Host: callback.Host, Path: r.URL.Path, RawQuery: r.URL.RawQuery}
			w.Header().Set("Cache-Control", "no-store")
			http.Redirect(w, r, destination.String(), http.StatusFound)
		})
	}
}
