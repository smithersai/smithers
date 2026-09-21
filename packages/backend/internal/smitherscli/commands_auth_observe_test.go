package smitherscli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestAuthObserveSingleCommand(t *testing.T) {
	const token = "smithers_browser_observe"
	const challenge = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	var issued int
	observe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/api/v1/auth/browser-handoff", r.URL.Path)
		require.Equal(t, "token "+token, r.Header.Get("Authorization"))
		require.Empty(t, r.URL.RawQuery)
		var body map[string]string
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		require.Equal(t, challenge, body["challenge"])
		issued++
		w.WriteHeader(201)
		fmt.Fprintf(w, `{"ticket":%q}`, challenge)
	}))
	defer observe.Close()
	commandsAuthCovSetConfig(t, "https://api.example.test")
	err := SaveConfig(map[string]string{"observe_url": observe.URL})
	require.NoError(t, err)
	var opens int
	authZWithOpenBrowser(t, func(start string) error {
		opens++
		require.NotContains(t, start, token)
		u, err := url.Parse(start)
		require.NoError(t, err)
		if opens == 1 {
			require.Equal(t, "1", u.Query().Get("admin"))
			require.Equal(t, "1h", u.Query().Get("ttl"))
			r := authZPostJSON(t, authZCallbackURL(t, start), map[string]string{"token": token, "username": "operator", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339), "callback_state": authZCallbackState(t, start)})
			require.Equal(t, 200, r.StatusCode)
			return r.Body.Close()
		}
		require.Equal(t, "/login/cli", u.Path)
		params, err := url.ParseQuery(u.Fragment)
		require.NoError(t, err)
		origin := "http://127.0.0.1:" + params.Get("port")
		callback := origin + "/observe"
		get, err := http.Get(callback)
		require.NoError(t, err)
		page, err := io.ReadAll(get.Body)
		require.NoError(t, err)
		get.Body.Close()
		require.NotContains(t, string(page), params.Get("state"))
		require.NotContains(t, string(page), token)
		for _, tc := range []struct {
			state, origin string
			status        int
		}{{"forged", origin, 403}, {params.Get("state"), "https://evil.test", 403}, {params.Get("state"), origin, 200}} {
			body, _ := json.Marshal(map[string]string{"state": tc.state, "challenge": challenge})
			req, _ := http.NewRequest("POST", callback, bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", tc.origin)
			response, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			content, _ := io.ReadAll(response.Body)
			response.Body.Close()
			require.Equal(t, tc.status, response.StatusCode, string(content))
			require.NotContains(t, string(content), token)
			if tc.status == 200 {
				var result map[string]string
				require.NoError(t, json.Unmarshal(content, &result))
				dest, err := url.Parse(result["url"])
				require.NoError(t, err)
				require.Equal(t, u.Host, dest.Host)
				require.Empty(t, dest.RawQuery)
				hash, _ := url.ParseQuery(dest.Fragment)
				require.Equal(t, params.Get("state"), hash.Get("state"))
				require.Equal(t, challenge, hash.Get("ticket"))
			}
		}
		return nil
	})
	out := commandsMoreHTTPHServe(t, authCommand(), "login", "--observe")
	require.Equal(t, 2, opens)
	require.Equal(t, 1, issued)
	require.Contains(t, out, "opened Observe")
	require.NotContains(t, out, token)
	target, err := ResolveAuthTarget(nil)
	require.NoError(t, err)
	record := readSmithersAuthRecordForTarget(target)
	require.NotNil(t, record)
	require.True(t, record.Admin)
	require.Equal(t, token, record.Token)
}

func TestObserveHandoffNoRedirectsOrErrorSecrets(t *testing.T) {
	var forwarded bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded = true }))
	defer destination.Close()
	for _, status := range []int{302, 307, 401, 500, 201} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", destination.URL)
				w.WriteHeader(status)
				io.WriteString(w, "smithers_secret_error")
			}))
			defer upstream.Close()
			_, err := issueObserveHandoff(context.Background(), upstream.URL, "smithers_secret_error", strings.Repeat("A", 43))
			require.Error(t, err)
			require.NotContains(t, err.Error(), "smithers_secret_error")
			require.False(t, forwarded)
		})
	}
}

func TestObserveBrowserTimeoutAndURLValidation(t *testing.T) {
	authZWithOpenBrowser(t, func(string) error { return nil })
	previous := browserLoginTimeout
	browserLoginTimeout = 10 * time.Millisecond
	t.Cleanup(func() { browserLoginTimeout = previous })
	require.ErrorContains(t, openObserveSession("http://127.0.0.1:1", "smithers_test"), "timed out")
	for _, base := range []string{"http://observe.example", "https://user@observe.example", "https://observe.example?token=x"} {
		require.Error(t, openObserveSession(base, "smithers_test"))
	}
}
