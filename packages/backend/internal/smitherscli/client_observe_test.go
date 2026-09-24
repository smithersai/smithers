package smitherscli

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestObserveClientErrorsAndRedirects(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
		want   string
	}{{403, `{"error":"forbidden","message":"scope required"}`, "scope required"}, {429, `{"message":"rate limited"}`, "rate limited"}, {500, `not JSON`, "not JSON"}, {200, `invalid`, "invalid"}, {204, "", ""}} {
		t.Run(fmt.Sprint(tc.status), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "token smithers_observe", r.Header.Get("Authorization"))
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer srv.Close()
			authFSetConfig(t, srv.URL)
			t.Setenv("SMITHERS_TOKEN", "smithers_observe")
			require.NoError(t, SaveConfig(map[string]string{"observe_url": srv.URL}))
			result, err := ObserveRequest("GET", "/api/v1/whoami", nil, "")
			if tc.want != "" {
				require.ErrorContains(t, err, tc.want)
			} else {
				require.NoError(t, err)
				require.Nil(t, result)
			}
		})
	}
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("PAT forwarded through redirect") }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, http.StatusFound) }))
	defer source.Close()
	authFSetConfig(t, source.URL)
	t.Setenv("SMITHERS_TOKEN", "smithers_observe")
	require.NoError(t, SaveConfig(map[string]string{"observe_url": source.URL}))
	_, err := ObserveRequest("GET", "/api/v1/whoami", nil, "")
	require.Error(t, err)
	_, err = ObserveRequest("POST", "/api/v1/alerts/channels", map[string]any{}, "")
	require.ErrorContains(t, err, "confirmation target")
}

func TestObserveURLConfig(t *testing.T) {
	authFSetConfig(t, "http://127.0.0.1:4321")
	require.Empty(t, mustLoadConfig(t).ObserveURL, "no Observe host is privileged by default")
	require.ErrorContains(t, validateObserveURL(""), "observe_url is not configured")
	for _, raw := range []string{"https://observe.example.com", "http://localhost:4321", "http://127.0.0.1:4321", "http://[::1]:4321"} {
		require.NoError(t, validateObserveURL(raw))
	}
	for _, raw := range []string{"http://observe.example.com", "ftp://observe.example.com", "https://user:password@observe.example.com", "/relative", "https://observe.example.com?token=x", "https://observe.example.com#x", "http://localhost.attacker.test"} {
		require.Error(t, validateObserveURL(raw))
		require.Error(t, SaveConfig(map[string]string{"observe_url": raw}))
	}
	commandsMoreHTTPHServe(t, configCommand(), "set", "observe_url", "https://observe.example.com", "--json")
	require.Equal(t, "https://observe.example.com", mustLoadConfig(t).ObserveURL)
	require.Contains(t, commandsMoreHTTPHServe(t, configCommand(), "get", "observe_url", "--json"), "https://observe.example.com")
	require.NoError(t, SaveConfig(map[string]string{"git_protocol": "https"}))
	require.Equal(t, "https://observe.example.com", mustLoadConfig(t).ObserveURL)
}

func TestAdminExpiredTokenHint(t *testing.T) {
	for _, tc := range []struct {
		name              string
		expired, override bool
		status            int
		hint              bool
	}{{"expired", true, false, 401, true}, {"valid-lifetime", false, false, 401, false}, {"different-env-token", true, true, 401, false}, {"forbidden", true, false, 403, false}} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				fmt.Fprint(w, `{"message":"access denied"}`)
			}))
			defer srv.Close()
			authFSetConfig(t, srv.URL)
			require.NoError(t, SaveConfig(map[string]string{"observe_url": srv.URL}))
			expiry := time.Now().Add(time.Hour)
			if tc.expired {
				expiry = time.Now().Add(-time.Hour)
			}
			_, err := PersistAuthToken("smithers_expired", map[string]string{"admin": "true", "expiresAt": expiry.UTC().Format(time.RFC3339)})
			require.NoError(t, err)
			if tc.override {
				t.Setenv("SMITHERS_TOKEN", "smithers_different")
			}
			for _, command := range [][]string{{"status"}, {"alerts", "channels", "list"}, {"user", "list"}} {
				var gotErr error
				_, gotErr = func() (any, error) {
					if command[0] == "alerts" {
						return ObserveRequest("GET", "/api/v1/alerts/channels", nil, "")
					}
					return APIRequest("GET", "/api/admin/system/status", nil, nil)
				}()
				require.Error(t, gotErr)
				require.Equal(t, tc.hint, strings.Contains(gotErr.Error(), expiredAdminLoginHint))
				if tc.hint {
					commandsMoreHTTPHServeWantErr(t, adminCommand(), expiredAdminLoginHint, command...)
				}
			}
		})
	}
}
