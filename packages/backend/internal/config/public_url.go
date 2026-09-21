package config

import "strings"

// ResolvePublicAPIOrigin returns the externally reachable HTTP origin used for
// links that must come back to the API service. APIBaseURL takes precedence
// over fallback (historically email.base_url), and a conventional trailing
// /api is removed because callers append their own API route paths.
func ResolvePublicAPIOrigin(apiBaseURL, fallback string) string {
	base := strings.TrimRight(strings.TrimSpace(apiBaseURL), "/")
	if base == "" {
		return strings.TrimRight(strings.TrimSpace(fallback), "/")
	}
	return strings.TrimSuffix(base, "/api")
}
