package smitherscli

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func authStatusServer(t *testing.T, statusCode int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(statusCode)
		if statusCode >= 200 && statusCode < 300 {
			fmt.Fprint(w, `{"login":"server-user"}`)
			return
		}
		fmt.Fprint(w, `{"message":"nope"}`)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestAuthStatus_OnlyAuthRejectionsMarkTokenInvalid(t *testing.T) {
	for _, tc := range []struct {
		name         string
		statusCode   int
		wantLoggedIn bool
		wantMessage  string
	}{
		{"ok", http.StatusOK, true, "Logged in to"},
		{"unauthorized", http.StatusUnauthorized, false, "invalid or expired"},
		{"forbidden", http.StatusForbidden, false, "invalid or expired"},
		{"rate limited", http.StatusTooManyRequests, true, "could not verify token: server returned 429"},
		{"server error", http.StatusInternalServerError, true, "could not verify token: server returned 500"},
		{"unavailable", http.StatusServiceUnavailable, true, "could not verify token: server returned 503"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := authStatusServer(t, tc.statusCode)
			authCovSetConfig(t, server.URL)
			t.Setenv("SMITHERS_TOKEN", "env-token")

			status := GetAuthStatus(server.Client(), nil)
			if status.LoggedIn != tc.wantLoggedIn || !status.TokenSet || !strings.Contains(status.Message, tc.wantMessage) {
				t.Fatalf("GetAuthStatus(%d) = %#v, want logged_in=%t message containing %q", tc.statusCode, status, tc.wantLoggedIn, tc.wantMessage)
			}
		})
	}
}

func TestAuthStatus_ExitCodeReflectsLoginState(t *testing.T) {
	for _, tc := range []struct {
		name       string
		statusCode int
		token      string
		args       []string
		wantExit   int
	}{
		{"logged in", http.StatusOK, "env-token", nil, 0},
		{"server unavailable stays logged in", http.StatusServiceUnavailable, "env-token", nil, 0},
		{"invalid token", http.StatusUnauthorized, "env-token", nil, 1},
		{"no token", http.StatusOK, "", nil, 1},
		{"no token json", http.StatusOK, "", []string{"--json"}, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := authStatusServer(t, tc.statusCode)
			authCovSetConfig(t, server.URL)
			t.Setenv("SMITHERS_TOKEN", tc.token)

			argv := append([]string{"auth", "status"}, tc.args...)
			if code := Run(argv); code != tc.wantExit {
				t.Fatalf("Run(%v) exit = %d, want %d", argv, code, tc.wantExit)
			}
		})
	}
}
