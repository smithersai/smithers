package smitherscli

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The browser-login loopback callback must never resolve a token from the query
// string: a cross-site <img src=".../callback?token=attacker"> (or a server that
// redirects with a query token) would otherwise fixate an attacker's token into
// the CLI (login CSRF / token fixation). The legitimate flow delivers the token
// in the URL fragment via the same-origin JSON bridge instead.
func TestCommandsAuth_RunBrowserLogin_RejectsQueryTokenFixation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		port := r.URL.Query().Get("callback_port")
		// Token in the QUERY string — the fixation vector, not the fragment.
		target := "http://127.0.0.1:" + port + "/callback?token=smithers_evil&username=attacker"
		http.Redirect(w, r, target, http.StatusFound)
	}))
	defer server.Close()
	commandsAuthCovSetConfig(t, server.URL)
	setTestBrowserFetch(t, true)

	prev := browserLoginTimeout
	browserLoginTimeout = 750 * time.Millisecond
	defer func() { browserLoginTimeout = prev }()

	result, err := runBrowserLogin(nil)
	if err == nil {
		t.Fatalf("expected no token to be accepted from the query string, but login succeeded: %#v", result)
	}
	if result.Token == "smithers_evil" {
		t.Fatal("query-string token was fixated into the CLI (login CSRF)")
	}
}
