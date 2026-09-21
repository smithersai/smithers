package smitherscli

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func httpFSetConfig(t *testing.T, apiURL, token string) {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_TEST_CREDENTIAL_STORE_FILE", "")
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(configHome, "auth.json"))
	t.Setenv("SMITHERS_TOKEN", token)
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func httpFServeErr(t *testing.T, cmd *incur.Cli, argv ...string) error {
	t.Helper()
	var out strings.Builder
	return cmd.ServeWithOptions(argv, incur.ServeOptions{Stdout: &out, Stderr: &out})
}

func TestCommandsHTTP_F_RawAPIRequest(t *testing.T) {
	// no auth -> RequireAuthToken error
	httpFSetConfig(t, "https://api.example.com", "")
	if _, err := rawAPIRequest("GET", "/x", nil, nil); err == nil {
		t.Fatal("rawAPIRequest no-auth error expected")
	}

	// marshal error via seam
	httpFSetConfig(t, "https://api.example.com", "tok")
	old := rawAPIMarshal
	rawAPIMarshal = func(any) ([]byte, error) { return nil, errors.New("marshal boom") }
	if _, err := rawAPIRequest("POST", "/x", map[string]string{"k": "v"}, nil); err == nil {
		t.Fatal("rawAPIRequest marshal error expected")
	}
	rawAPIMarshal = old

	// NewRequest error (space in URL)
	httpFSetConfig(t, "http://bad host", "tok")
	if _, err := rawAPIRequest("GET", "/x", nil, nil); err == nil {
		t.Fatal("rawAPIRequest NewRequest error expected")
	}

	// Do error (unreachable)
	httpFSetConfig(t, "http://127.0.0.1:1", "tok")
	if _, err := rawAPIRequest("GET", "/x", nil, nil); err == nil {
		t.Fatal("rawAPIRequest Do error expected")
	}

	// non-JSON 2xx body -> printed, returns nil
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "hello-not-json")
	}))
	defer plain.Close()
	httpFSetConfig(t, plain.URL, "tok")
	if res, err := rawAPIRequest("GET", "/x", nil, nil); err != nil || res != nil {
		t.Fatalf("rawAPIRequest plain body = %#v, %v", res, err)
	}
}

func TestCommandsHTTP_F_ResolveRepoErrors(t *testing.T) {
	httpFSetConfig(t, "https://api.example.com", "tok")
	// Ensure no repo can be auto-detected: run from an empty temp dir with no jj/git.
	t.Setenv("PATH", t.TempDir())

	cases := []struct {
		cmd  *incur.Cli
		argv []string
	}{
		{labelCommand(), []string{"create", "bug", "--repo", "badformat"}},
		{labelCommand(), []string{"delete", "5", "--repo", "badformat"}},
		{variableCommand(), []string{"get", "name", "--repo", "badformat"}},
		{variableCommand(), []string{"set", "name", "--body", "v", "--repo", "badformat"}},
		{cacheCommand(), []string{"list", "--repo", "badformat"}},
		{cacheCommand(), []string{"clear", "--repo", "badformat"}},
		{secretCommand(), []string{"delete", "name", "--repo", "badformat"}},
		{variableCommand(), []string{"delete", "name", "--repo", "badformat"}},
	}
	for _, tc := range cases {
		if err := httpFServeErr(t, tc.cmd, tc.argv...); err == nil {
			t.Fatalf("expected ResolveRepoRef error for %v", tc.argv)
		}
	}
}

func TestCommandsHTTP_F_APIRequestErrors(t *testing.T) {
	httpFSetConfig(t, "http://127.0.0.1:1", "tok")
	cases := []struct {
		cmd  *incur.Cli
		argv []string
	}{
		{labelCommand(), []string{"delete", "5", "--repo", "alice/demo"}},
		{sshKeyCommand(), []string{"delete", "5"}},
		{cacheCommand(), []string{"list", "--repo", "alice/demo"}},
		{notificationCommand(), []string{"list", "--all"}},
		{notificationCommand(), []string{"list"}},
		{notificationCommand(), []string{"read", "--all"}},
		{secretCommand(), []string{"delete", "name", "--repo", "alice/demo"}},
	}
	for _, tc := range cases {
		if err := httpFServeErr(t, tc.cmd, tc.argv...); err == nil {
			t.Fatalf("expected APIRequest error for %v", tc.argv)
		}
	}
}

func TestCommandsHTTP_F_NotificationListNoCursor(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `[{"id":"1"}]`)
	}))
	defer server.Close()
	httpFSetConfig(t, server.URL, "tok")
	if err := httpFServeErr(t, notificationCommand(), "list"); err != nil {
		t.Fatalf("notification list no cursor = %v", err)
	}
}

func TestCommandsHTTP_F_SecretSetStdinBranches(t *testing.T) {
	httpFSetConfig(t, "http://127.0.0.1:1", "tok")

	// body-stdin false -> validation error
	if err := httpFServeErr(t, secretCommand(), "set", "name"); err == nil {
		t.Fatal("secret set without --body-stdin should error")
	}

	// body-stdin true but empty stdin -> readStdinText error
	withStdin(t, "", func() {
		if err := httpFServeErr(t, secretCommand(), "set", "name", "--body-stdin"); err == nil {
			t.Fatal("secret set empty stdin should error")
		}
	})

	// body-stdin true with content, then ResolveRepoRef error
	t.Setenv("PATH", t.TempDir())
	withStdin(t, "secret-value", func() {
		if err := httpFServeErr(t, secretCommand(), "set", "name", "--body-stdin", "--repo", "badformat"); err == nil {
			t.Fatal("secret set bad repo should error")
		}
	})
}

func withStdin(t *testing.T, content string, fn func()) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdin
	os.Stdin = r
	defer func() { os.Stdin = old }()
	go func() {
		_, _ = w.WriteString(content)
		_ = w.Close()
	}()
	fn()
	_ = r.Close()
}

func TestCommandsHTTP_F_ReadStdinText(t *testing.T) {
	// char device stdin -> "must be provided on stdin"
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdin
	os.Stdin = devnull
	_, cerr := readStdinText("value", false)
	os.Stdin = old
	_ = devnull.Close()
	if cerr == nil {
		t.Fatal("readStdinText char device should error")
	}

	// closed pipe -> ReadAll error
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_ = w.Close()
	_ = r.Close()
	os.Stdin = r
	_, rerr := readStdinText("value", false)
	os.Stdin = old
	if rerr == nil {
		t.Fatal("readStdinText closed pipe should error")
	}
}
