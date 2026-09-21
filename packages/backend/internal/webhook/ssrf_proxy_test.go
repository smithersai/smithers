package webhook

import (
	"net/http"
	"testing"
)

// SafeHTTPClient must not honor an environment proxy. If it did, a request would
// dial the proxy host (which safeDialContext validates as safe) and the proxy
// would connect onward to the real, attacker-controlled target — bypassing the
// dial-time restricted-IP SSRF guard entirely.
func TestSafeHTTPClientDisablesEnvProxy(t *testing.T) {
	client := SafeHTTPClient()

	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("SafeHTTPClient transport is %T, want *http.Transport", client.Transport)
	}
	if transport.Proxy != nil {
		t.Fatal("SafeHTTPClient transport.Proxy must be nil: an env proxy bypasses the SSRF restricted-IP dial guard")
	}
}
