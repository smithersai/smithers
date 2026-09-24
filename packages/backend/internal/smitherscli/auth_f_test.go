package smitherscli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	incur "github.com/smithersai/incur"
	"github.com/stretchr/testify/require"
)

func authFSetConfig(t *testing.T, apiURL string) string {
	t.Helper()
	root := t.TempDir()
	configHome := filepath.Join(root, "config")
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(root, "auth.json"))
	setTestCredentialStoreFile(t, filepath.Join(root, "credentials.json"))
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_TOKEN", "")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func authFWithResolverError(t *testing.T) {
	t.Helper()
	old := authTargetResolver
	authTargetResolver = func(map[string]string) (AuthTarget, error) {
		return AuthTarget{}, errors.New("resolver boom")
	}
	t.Cleanup(func() { authTargetResolver = old })
}

func TestAuth_F_ResolverErrorPropagation(t *testing.T) {
	authFSetConfig(t, "https://api.example.com")
	authFWithResolverError(t)

	if _, err := ResolveAuthToken(nil); err == nil {
		t.Fatal("ResolveAuthToken should propagate resolver error")
	}
	if _, err := RequireAuthToken(nil); err == nil {
		t.Fatal("RequireAuthToken should propagate resolver error")
	}
	if _, err := PersistAuthToken("tok", nil); err == nil {
		t.Fatal("PersistAuthToken should propagate resolver error")
	}
	if _, err := ClearAuthToken(nil); err == nil {
		t.Fatal("ClearAuthToken should propagate resolver error")
	}
	if got := GetAuthStatus(nil, nil); got.Message != "resolver boom" {
		t.Fatalf("GetAuthStatus resolver error message = %q", got.Message)
	}
}

func TestAuth_F_RequireAuthTokenSecondResolveError(t *testing.T) {
	authFSetConfig(t, "https://api.example.com")
	old := authTargetResolver
	calls := 0
	authTargetResolver = func(options map[string]string) (AuthTarget, error) {
		calls++
		if calls >= 2 {
			return AuthTarget{}, errors.New("second boom")
		}
		return old(options)
	}
	t.Cleanup(func() { authTargetResolver = old })

	// No token configured, so ResolveAuthToken returns (nil, nil), then the
	// second authTargetResolver call inside RequireAuthToken errors.
	if _, err := RequireAuthToken(nil); err == nil || err.Error() != "second boom" {
		t.Fatalf("RequireAuthToken second resolve error = %v", err)
	}
}

func TestAuth_F_RequireAuthTokenNoToken(t *testing.T) {
	authFSetConfig(t, "https://api.example.com")
	if _, err := RequireAuthToken(nil); err == nil {
		t.Fatal("RequireAuthToken with no token should error")
	}
}

func TestAuth_F_ReadSmithersAuthFileEdge(t *testing.T) {
	root := t.TempDir()

	// read error: path is a directory
	dirPath := filepath.Join(root, "adir")
	if err := os.MkdirAll(dirPath, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SMITHERS_AUTH_FILE", dirPath)
	if _, err := readSmithersAuthFile(); err == nil {
		t.Fatal("readSmithersAuthFile on directory should error")
	}

	// empty file -> nil, nil
	emptyPath := filepath.Join(root, "empty.json")
	if err := os.WriteFile(emptyPath, []byte("   \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SMITHERS_AUTH_FILE", emptyPath)
	if rec, err := readSmithersAuthFile(); err != nil || rec != nil {
		t.Fatalf("readSmithersAuthFile empty = %#v, %v", rec, err)
	}
}

func TestAuth_F_WriteSmithersAuthFileErrors(t *testing.T) {
	root := t.TempDir()

	// MkdirAll error: parent path is a file
	filePath := filepath.Join(root, "afile")
	if err := os.WriteFile(filePath, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(filePath, "child", "auth.json"))
	if err := writeSmithersAuthFile(AuthTarget{Host: "h"}, "tok", authTokenMetadata{}); err == nil {
		t.Fatal("writeSmithersAuthFile mkdir error expected")
	}

	// marshal error via seam
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(root, "ok.json"))
	old := authMarshalIndent
	authMarshalIndent = func(any, string, string) ([]byte, error) { return nil, errors.New("marshal boom") }
	t.Cleanup(func() { authMarshalIndent = old })
	if err := writeSmithersAuthFile(AuthTarget{Host: "h"}, "tok", authTokenMetadata{}); err == nil {
		t.Fatal("writeSmithersAuthFile marshal error expected")
	}
}

func TestAuth_F_PersistAuthTokenStoreAndFileErrors(t *testing.T) {
	root := authFSetConfig(t, "https://api.example.com")

	// StoreToken returns a non-unavailable error: point the test store at a
	// directory so writeTestStore fails.
	storeDir := filepath.Join(root, "storedir")
	if err := os.MkdirAll(storeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	setTestCredentialStoreFile(t, storeDir)
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "")
	if _, err := PersistAuthToken("tok", nil); err == nil {
		t.Fatal("PersistAuthToken should surface StoreToken failure")
	}
}

func TestAuth_F_PersistAuthTokenWriteFileError(t *testing.T) {
	root := authFSetConfig(t, "https://api.example.com")
	// StoreToken returns unavailable (keyring disabled, no store file) -> skipped.
	setTestCredentialStoreFile(t, "")
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	// writeSmithersAuthFile fails: auth file parent is a regular file.
	blocker := filepath.Join(root, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(blocker, "child", "auth.json"))
	if _, err := PersistAuthToken("tok", nil); err == nil {
		t.Fatal("PersistAuthToken should surface writeSmithersAuthFile failure")
	}
}

func TestAuth_F_PersistAuthTokenSaveConfigError(t *testing.T) {
	authFSetConfig(t, "https://api.example.com")
	setTestCredentialStoreFile(t, "")
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	// writeSmithersAuthFile succeeds (default auth file path), SaveConfig fails.
	oldMkdir := configMkdirAll
	configMkdirAll = func(string, os.FileMode) error { return errors.New("saveconfig boom") }
	t.Cleanup(func() { configMkdirAll = oldMkdir })
	if _, err := PersistAuthToken("tok", nil); err == nil {
		t.Fatal("PersistAuthToken should surface SaveConfig failure")
	}
}

func TestAuth_F_GetAuthStatusNewRequestError(t *testing.T) {
	// api_url with a space -> valid YAML, invalid URL for http.NewRequest.
	authFSetConfig(t, "http://bad host.invalid")
	t.Setenv("SMITHERS_TOKEN", "env-token")
	got := GetAuthStatus(http.DefaultClient, nil)
	if !got.LoggedIn || !got.TokenSet {
		t.Fatalf("GetAuthStatus NewRequest error = %#v", got)
	}
}

type authFErrTransport struct{}

func (authFErrTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("transport boom")
}

func TestAuth_F_GetAuthStatusDoError(t *testing.T) {
	authFSetConfig(t, "https://api.example.com")
	t.Setenv("SMITHERS_TOKEN", "env-token")
	client := &http.Client{Transport: authFErrTransport{}}
	got := GetAuthStatus(client, nil)
	if !got.LoggedIn || got.Message == "" {
		t.Fatalf("GetAuthStatus Do error = %#v", got)
	}
}

func TestAuth_F_GetAuthStatusUsernameOnly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"login": "alice"})
	}))
	defer server.Close()
	authFSetConfig(t, server.URL)
	t.Setenv("SMITHERS_TOKEN", "env-token")
	got := GetAuthStatus(server.Client(), nil)
	if !got.LoggedIn || got.Username != "alice" {
		t.Fatalf("GetAuthStatus username only = %#v", got)
	}
	if want := fmt.Sprintf("Logged in to %s as alice via", got.Host); got.Message[:len(want)] != want {
		t.Fatalf("GetAuthStatus username-only message = %q", got.Message)
	}
}

func TestAuth_F_FirstNonEmptyAllBlank(t *testing.T) {
	if got := firstNonEmpty("", "  ", "\t"); got != "" {
		t.Fatalf("firstNonEmpty all blank = %q", got)
	}
}

func TestAuth_F_AdminBrowserLoginFlagsAndExpiry(t *testing.T) {
	expiry := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	for _, ttl := range []string{"", "5m", "12h"} {
		t.Run("ttl="+ttl, func(t *testing.T) {
			var started bool
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/user" {
					fmt.Fprint(w, `{"username":"operator","is_admin":true}`)
					return
				}
				require.Equal(t, "/api/auth/github/cli", r.URL.Path)
				require.Equal(t, "1", r.URL.Query().Get("admin"))
				want := ttl
				if want == "" {
					want = "1h"
				}
				require.Equal(t, want, r.URL.Query().Get("ttl"))
				require.NotEmpty(t, r.URL.Query().Get("callback_port"))
				started = true
				values := url.Values{"callback_state": {r.URL.Query().Get("callback_state")}, "token": {"smithers_browser_admin"}, "username": {"operator"}, "expires_at": {expiry.Format(time.RFC3339)}}
				http.Redirect(w, r, "http://127.0.0.1:"+r.URL.Query().Get("callback_port")+"/callback#"+values.Encode(), http.StatusFound)
			}))
			defer server.Close()
			authFSetConfig(t, server.URL)
			setTestBrowserFetch(t, true)
			args := []string{"login", "--admin", "--host", server.URL, "--json"}
			if ttl != "" {
				args = append(args, "--ttl", ttl)
			}
			out := commandsMoreHTTPHServe(t, authCommand(), args...)
			require.True(t, started)
			require.Contains(t, out, expiry.Format(time.RFC3339))
			require.Contains(t, out, "admin")
			target, err := ResolveAuthTarget(nil)
			require.NoError(t, err)
			record := readSmithersAuthRecordForTarget(target)
			require.NotNil(t, record)
			require.True(t, record.Admin)
			require.Equal(t, expiry.Format(time.RFC3339), record.ExpiresAt)
			status := GetAuthStatus(server.Client(), nil)
			require.True(t, status.Admin)
			require.Equal(t, record.ExpiresAt, status.ExpiresAt)
			require.NotEmpty(t, status.TimeLeft)
			require.Contains(t, formatAuthStatus(status), "admin: true")
			require.Contains(t, formatAuthStatus(status), "time_left:")
		})
	}
}

func TestAuth_F_AdminInvalidFlags(t *testing.T) {
	for _, args := range [][]string{{"login", "--admin", "--ttl", "4m"}, {"login", "--admin", "--ttl", "12h1s"}, {"login", "--admin", "--ttl", "bad"}, {"login", "--ttl", "1h"}, {"login", "--admin", "--with-token"}} {
		var out bytes.Buffer
		require.Error(t, authCommand().ServeWithOptions(args, incur.ServeOptions{Stdout: &out}))
	}
}
