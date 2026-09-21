package smitherscli

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func shortenBrowserLoginTimeout(t *testing.T) {
	t.Helper()
	previous := browserLoginTimeout
	browserLoginTimeout = 100 * time.Millisecond
	t.Cleanup(func() { browserLoginTimeout = previous })
}

func TestBrowserLoginFetchDeadline(t *testing.T) {
	for _, stage := range []string{"start", "follow", "callback"} {
		t.Run(stage, func(t *testing.T) {
			shortenBrowserLoginTimeout(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/login" && stage != "start" {
					location := "/" + stage
					if stage == "callback" {
						location += "#token=smithers_test&callback_state=" + strings.Repeat("A", 43)
					}
					http.Redirect(w, r, location, http.StatusFound)
					return
				}
				_, _ = io.Copy(io.Discard, r.Body)
				// The fallback keeps this regression bounded even without cancellation.
				select {
				case <-r.Context().Done():
				case <-time.After(2 * time.Second):
				}
			}))
			defer server.Close()

			started := time.Now()
			err := fetchBrowserLoginURL(server.URL + "/login")
			require.ErrorIs(t, err, context.DeadlineExceeded)
			require.Less(t, time.Since(started), time.Second)
		})
	}
}

func TestBrowserLoginTimeoutClosesPendingCallback(t *testing.T) {
	for _, callback := range []string{"absent", "missing state", "wrong state", "incomplete body"} {
		t.Run(callback, func(t *testing.T) {
			commandsAuthCovSetConfig(t, "https://api.example.test")
			shortenBrowserLoginTimeout(t)
			var callbackURL string
			authZWithOpenBrowser(t, func(loginURL string) error {
				callbackURL = authZCallbackURL(t, loginURL)
				switch callback {
				case "missing state", "wrong state":
					state := ""
					if callback == "wrong state" {
						state = strings.Repeat("A", 43)
					}
					resp := authZPostJSON(t, callbackURL, map[string]string{
						"token": "smithers_rejected", "callback_state": state,
					})
					require.Equal(t, http.StatusForbidden, resp.StatusCode)
					return resp.Body.Close()
				case "incomplete body":
					address := strings.TrimSuffix(strings.TrimPrefix(callbackURL, "http://"), "/callback")
					conn, err := net.DialTimeout("tcp", address, time.Second)
					require.NoError(t, err)
					t.Cleanup(func() { _ = conn.Close() })
					// Rescue the old unbounded Shutdown without hanging the test itself.
					rescue := time.AfterFunc(2*time.Second, func() { _ = conn.Close() })
					t.Cleanup(func() { rescue.Stop() })
					_, err = fmt.Fprintf(conn, "POST /callback HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{", address)
					return err
				}
				return nil
			})

			started := time.Now()
			result, err := runBrowserLogin(nil)
			require.ErrorContains(t, err, "Timed out waiting for")
			require.Empty(t, result.Token)
			require.Less(t, time.Since(started), time.Second)
			client := &http.Client{Timeout: time.Second}
			resp, err := client.Get(callbackURL)
			if resp != nil {
				_ = resp.Body.Close()
			}
			require.Error(t, err, "the expired login must stop listening")
		})
	}
}
