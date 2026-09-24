package smitherscli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// A server that accepts the connection and never answers must fail the
// request instead of hanging the CLI.
func TestAPIRequest_ServerThatNeverRespondsTimesOut(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() { close(release); server.Close() })
	authFSetConfig(t, server.URL)
	t.Setenv("SMITHERS_TOKEN", "tok")

	previousTimeout, previousClient := apiRequestTimeout, apiHTTPClient
	apiRequestTimeout = 200 * time.Millisecond
	apiHTTPClient = newAPIHTTPClient()
	t.Cleanup(func() { apiRequestTimeout, apiHTTPClient = previousTimeout, previousClient })

	done := make(chan error, 1)
	go func() {
		_, err := APIRequest(http.MethodGet, "/api/user", nil, nil)
		done <- err
	}()
	select {
	case err := <-done:
		require.Error(t, err)
		require.ErrorContains(t, err, "deadline exceeded")
	case <-time.After(10 * time.Second):
		t.Fatal("APIRequest hung on a server that never responds")
	}
}

// The CLI keeps the server's typed verdict and request id, and names itself
// in User-Agent.
func TestAPIRequest_TypedErrorRoundTrip(t *testing.T) {
	var userAgent atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userAgent.Store(r.Header.Get("User-Agent"))
		w.Header().Set("X-Request-Id", "req-123")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = fmt.Fprint(w, `{"code":"rate_limited","fault":"user","retry_after":7,"message":"slow down"}`)
	}))
	defer server.Close()
	authFSetConfig(t, server.URL)
	t.Setenv("SMITHERS_TOKEN", "tok")
	t.Setenv("SMITHERS_CLI_VERSION", "9.8.7")

	_, err := APIRequest(http.MethodGet, "/api/user", nil, nil)
	var apiErr *APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, http.StatusTooManyRequests, apiErr.Status)
	require.Equal(t, "rate_limited", apiErr.Code)
	require.Equal(t, "user", apiErr.Fault)
	require.Equal(t, 7, apiErr.RetryAfter)
	require.Equal(t, "slow down", apiErr.Detail)
	require.Equal(t, "req-123", apiErr.RequestID)
	require.Contains(t, err.Error(), "[request req-123]")
	require.Contains(t, err.Error(), "retry after 7s")
	require.Equal(t, "smithers-cli/9.8.7", userAgent.Load())

	// `smithers api` prints the message but keeps the typed error reachable.
	_, err = rawAPIRequest(http.MethodGet, "/api/user", nil, nil)
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, "slow down [request req-123]", err.Error())
}

func TestAPIListAll_StopsOnRepeatedCursor(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Link", `<`+r.URL.Path+`?cursor=same>; rel="next"`)
		_, _ = fmt.Fprint(w, `[{"id":1}]`)
	}))
	defer server.Close()
	authFSetConfig(t, server.URL)
	t.Setenv("SMITHERS_TOKEN", "tok")

	_, err := APIListAll(func(cursor string) string { return "/api/items?cursor=" + cursor }, nil)
	require.ErrorContains(t, err, `repeated pagination cursor "same"`)
	require.Equal(t, int32(2), calls.Load())
}

func TestAPIListAll_CapsPages(t *testing.T) {
	var page atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next := page.Add(1)
		w.Header().Set("Link", fmt.Sprintf(`<%s?cursor=c%d>; rel="next"`, r.URL.Path, next))
		_, _ = fmt.Fprint(w, `[]`)
	}))
	defer server.Close()
	authFSetConfig(t, server.URL)
	t.Setenv("SMITHERS_TOKEN", "tok")
	previous := maxListPages
	maxListPages = 3
	t.Cleanup(func() { maxListPages = previous })

	_, err := APIListAll(func(cursor string) string { return "/api/items?cursor=" + cursor }, nil)
	require.ErrorContains(t, err, "stopped listing after 3 pages")
}

// Only 401 and 403 mean the token is bad. An outage or a rate limit must not
// tell the user to log in again.
func TestGetAuthStatus_ClassifiesServerStatuses(t *testing.T) {
	for _, tc := range []struct {
		status   int
		loggedIn bool
		message  string
	}{
		{http.StatusUnauthorized, false, "is invalid or expired"},
		{http.StatusForbidden, false, "is invalid or expired"},
		{http.StatusTooManyRequests, true, "could not verify token: server returned 429"},
		{http.StatusServiceUnavailable, true, "could not verify token: server returned 503"},
	} {
		t.Run(fmt.Sprint(tc.status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
			}))
			defer server.Close()
			authFSetConfig(t, server.URL)
			t.Setenv("SMITHERS_TOKEN", "tok")

			status := GetAuthStatus(nil, nil)
			require.Equal(t, tc.loggedIn, status.LoggedIn, status.Message)
			require.Contains(t, status.Message, tc.message)
		})
	}
}

// A keychain-backed login leaves no plaintext token on disk; the metadata
// still drives `auth status`.
func TestPersistAuthToken_KeyringLoginWritesNoPlaintextToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "token smithers_secret", r.Header.Get("Authorization"))
		_, _ = fmt.Fprint(w, `{"login":"ada"}`)
	}))
	defer server.Close()
	root := authFSetConfig(t, server.URL)

	expires := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	_, err := PersistAuthToken("smithers_secret", map[string]string{"username": "ada", "expiresAt": expires, "admin": "true"})
	require.NoError(t, err)

	raw, err := os.ReadFile(filepath.Join(root, "auth.json"))
	require.NoError(t, err)
	require.NotContains(t, string(raw), "smithers_secret")
	var record smithersAuthFileRecord
	require.NoError(t, json.Unmarshal(raw, &record))
	require.Empty(t, record.Token)
	require.Equal(t, "ada", record.Username)

	resolved, err := ResolveAuthToken(nil)
	require.NoError(t, err)
	require.Equal(t, AuthTokenSourceKeyring, resolved.Source)
	status := GetAuthStatus(nil, nil)
	require.True(t, status.LoggedIn)
	require.True(t, status.Admin, "metadata-only record must still describe the keyring token")
	require.NotEmpty(t, status.TimeLeft)
}

// Without secure storage the token has nowhere else to live, so it goes to
// auth.json and the CLI still resolves it.
func TestPersistAuthToken_NoKeyringStoresTokenInFile(t *testing.T) {
	root := authFSetConfig(t, "https://api.example.com")
	setTestCredentialStoreFile(t, "")

	_, err := PersistAuthToken("smithers_file_token", nil)
	require.NoError(t, err)
	raw, err := os.ReadFile(filepath.Join(root, "auth.json"))
	require.NoError(t, err)
	require.Contains(t, string(raw), "smithers_file_token")
	resolved, err := ResolveAuthToken(nil)
	require.NoError(t, err)
	require.Equal(t, AuthTokenSourceSmithersAuthFile, resolved.Source)
}

// An unreadable keychain is reported as such, not as "not logged in".
func TestResolveAuthToken_SurfacesSecureStorageReadFailure(t *testing.T) {
	root := authFSetConfig(t, "https://api.example.com")
	storePath := filepath.Join(root, "credentials.json")
	require.NoError(t, os.WriteFile(storePath, []byte("{not-json"), 0o600))
	setTestCredentialStoreFile(t, storePath)

	_, err := ResolveAuthToken(nil)
	var readErr *SecureStorageReadError
	require.ErrorAs(t, err, &readErr)
	require.ErrorContains(t, err, "secure storage unavailable")
	_, err = RequireAuthToken(nil)
	require.ErrorContains(t, err, "secure storage unavailable")
	require.NotContains(t, err.Error(), "smithers auth login")

	status := GetAuthStatus(nil, nil)
	require.False(t, status.LoggedIn)
	require.Contains(t, status.Message, "secure storage unavailable")
}

// A self-hosted admin with no observe_url must not send their PAT anywhere.
func TestObserveRequest_FailsClosedWithoutObserveURL(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer server.Close()
	authFSetConfig(t, server.URL)
	t.Setenv("SMITHERS_TOKEN", "smithers_admin")

	_, err := ObserveRequest(http.MethodGet, "/api/v1/alerts/channels", nil, "")
	require.ErrorContains(t, err, "observe_url is not configured")
	require.Zero(t, hits.Load())
}

// A config file with a typo is an error, and saving refuses to overwrite it,
// so api_origin and other settings survive.
func TestConfig_CorruptFileIsNotOverwritten(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_API_ORIGIN", "")
	path := filepath.Join(configHome, "smithers", "config.toon")
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	corrupt := "api_origin: https://api.example.com\nobserve_url: [oops\n"
	require.NoError(t, os.WriteFile(path, []byte(corrupt), 0o644))

	_, err := LoadConfig()
	require.ErrorContains(t, err, "is invalid")
	require.ErrorContains(t, SaveConfig(map[string]string{"git_protocol": "https"}), "is invalid")
	_, err = ClearLegacyToken()
	require.ErrorContains(t, err, "is invalid")
	_, err = ResolveAuthTarget(nil)
	require.ErrorContains(t, err, "is invalid")

	after, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Equal(t, corrupt, string(after))
}

// `stack land` with no GITHUB_TOKEN reads PR state through the Smithers
// GitHub proxy, and a GitHub failure refuses the land with the real cause.
func TestStackLand_ReadsPRStateThroughProxyWithoutGitHubToken(t *testing.T) {
	var failReviews atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/api/repos/alice/demo/github-proxy", r.URL.Path)
		var body struct {
			Method string `json:"method"`
			Path   string `json:"path"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		switch {
		case body.Path == "/repos/alice/demo/pulls/7":
			_, _ = fmt.Fprint(w, `{"state":"open","mergeable":true,"head":{"sha":"abc"}}`)
		case body.Path == "/repos/alice/demo/commits/abc/check-runs":
			_, _ = fmt.Fprint(w, `{"check_runs":[{"name":"ci","status":"completed","conclusion":"success"}]}`)
		case body.Path == "/repos/alice/demo/pulls/7/reviews" && failReviews.Load():
			w.WriteHeader(http.StatusBadGateway)
			_, _ = fmt.Fprint(w, `{"code":"upstream_error","fault":"infra","message":"GitHub returned 502"}`)
		case body.Path == "/repos/alice/demo/pulls/7/reviews":
			_, _ = fmt.Fprint(w, `[{"user":{"login":"bob"},"state":"APPROVED"}]`)
		default:
			t.Errorf("unexpected proxy path %s", body.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	commandsStackHSetAPIConfig(t, server.URL)
	t.Setenv("GITHUB_TOKEN", "")

	change := stackLandChange{ChangeID: "kkkkkkkk", PRNumber: 7, PRState: "open", ReviewStatus: "pending", CIStatus: "pending"}
	refreshed, err := refreshStackLandChange("alice", "demo", change)
	require.NoError(t, err)
	require.Equal(t, "approved", refreshed.ReviewStatus)
	require.Equal(t, "passing", refreshed.CIStatus)
	require.Empty(t, stackLandabilityError(refreshed))

	failReviews.Store(true)
	_, err = refreshStackLandChange("alice", "demo", change)
	require.ErrorContains(t, err, "could not read reviews for PR #7")
	var apiErr *APIError
	require.True(t, errors.As(err, &apiErr))
	require.Equal(t, "infra", apiErr.Fault)
	require.True(t, strings.Contains(err.Error(), "GitHub returned 502"))
}
