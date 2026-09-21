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

func moreHTTPFSetConfig(t *testing.T, apiURL, token string) {
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

func moreHTTPFServe(t *testing.T, cmd *incur.Cli, argv ...string) error {
	t.Helper()
	var out strings.Builder
	return cmd.ServeWithOptions(argv, incur.ServeOptions{Stdout: &out, Stderr: &out})
}

func TestCommandsMoreHTTP_F_ResolveRepoErrors(t *testing.T) {
	moreHTTPFSetConfig(t, "https://api.example.com", "tok")
	t.Setenv("PATH", t.TempDir())
	cases := []struct {
		cmd  *incur.Cli
		argv []string
	}{
		{webhookCommand(), []string{"view", "1", "--repo", "badformat"}},
		{webhookCommand(), []string{"update", "1", "--repo", "badformat"}},
		{webhookCommand(), []string{"delete", "1", "--repo", "badformat"}},
		{webhookCommand(), []string{"deliveries", "1", "--repo", "badformat"}},
		{artifactCommand(), []string{"download", "1", "art", "--repo", "badformat"}},
	}
	for _, tc := range cases {
		if err := moreHTTPFServe(t, tc.cmd, tc.argv...); err == nil {
			t.Fatalf("expected ResolveRepoRef error for %v", tc.argv)
		}
	}
}

func TestCommandsMoreHTTP_F_WebhookSecretStdinErrors(t *testing.T) {
	moreHTTPFSetConfig(t, "http://127.0.0.1:1", "tok")
	// Char-device stdin makes readStdinText fail.
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdin
	os.Stdin = devnull
	defer func() { os.Stdin = old; _ = devnull.Close() }()

	if err := moreHTTPFServe(t, webhookCommand(), "create", "--url", "http://x", "--secret-stdin", "--repo", "alice/demo"); err == nil {
		t.Fatal("webhook create secret-stdin should error")
	}
	if err := moreHTTPFServe(t, webhookCommand(), "update", "1", "--secret-stdin", "--repo", "alice/demo"); err == nil {
		t.Fatal("webhook update secret-stdin should error")
	}
}

func TestCommandsMoreHTTP_F_ArtifactDownloadNameFallbackAndAbsError(t *testing.T) {
	var bytesURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/artifact-bytes":
			fmt.Fprint(w, "artifact body")
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/download"):
			// name intentionally empty to exercise the fallback branch
			fmt.Fprintf(w, `{"download_url":%q,"name":"","size":13,"content_type":"text/plain"}`, bytesURL)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	bytesURL = server.URL + "/artifact-bytes"
	moreHTTPFSetConfig(t, server.URL, "tok")

	outPath := filepath.Join(t.TempDir(), "artifact.bin")
	if err := moreHTTPFServe(t, artifactCommand(), "download", "1", "art", "--repo", "alice/demo", "--output", outPath, "--json"); err != nil {
		t.Fatalf("artifact download name fallback = %v", err)
	}
	if raw, err := os.ReadFile(outPath); err != nil || string(raw) != "artifact body" {
		t.Fatalf("downloaded artifact = %q, %v", raw, err)
	}

	// filepath.Abs error via seam
	oldAbs := moreHTTPAbs
	moreHTTPAbs = func(string) (string, error) { return "", errors.New("abs boom") }
	defer func() { moreHTTPAbs = oldAbs }()
	if err := moreHTTPFServe(t, artifactCommand(), "download", "1", "art", "--repo", "alice/demo", "--output", outPath, "--json"); err == nil {
		t.Fatal("artifact download Abs error expected")
	}
}

func TestCommandsMoreHTTP_F_ArtifactOutputNameSanitizesServerPath(t *testing.T) {
	cases := []struct {
		name string
		want string
	}{
		{"artifact.txt", "artifact.txt"},
		{"nested/artifact.txt", "artifact.txt"},
		{"../outside/pwned.txt", "pwned.txt"},
		{"/tmp/pwned.txt", "pwned.txt"},
		{`C:/tmp/pwned.txt`, "pwned.txt"},
		{`C:\tmp\pwned.txt`, "pwned.txt"},
		{`..\outside\pwned.txt`, "pwned.txt"},
	}
	for _, tc := range cases {
		got, err := artifactOutputName(tc.name)
		if err != nil {
			t.Fatalf("artifactOutputName(%q) error = %v", tc.name, err)
		}
		if got != tc.want {
			t.Fatalf("artifactOutputName(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestCommandsMoreHTTP_F_ArtifactOutputNameRejectsEmptyBase(t *testing.T) {
	for _, name := range []string{"", ".", "..", "/", `..\`} {
		if got, err := artifactOutputName(name); err == nil {
			t.Fatalf("artifactOutputName(%q) = %q, want error", name, got)
		}
	}
}

func TestCommandsMoreHTTP_F_ArtifactDownloadDefaultOutputUsesBaseName(t *testing.T) {
	var bytesURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/artifact-bytes":
			fmt.Fprint(w, "safe artifact body")
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/download"):
			fmt.Fprintf(w, `{"download_url":%q,"name":"../outside/pwned.txt","size":18,"content_type":"text/plain"}`, bytesURL)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	bytesURL = server.URL + "/artifact-bytes"
	moreHTTPFSetConfig(t, server.URL, "tok")

	root := t.TempDir()
	downloadDir := filepath.Join(root, "downloads")
	outsideDir := filepath.Join(root, "outside")
	if err := os.MkdirAll(downloadDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatal(err)
	}
	oldAbs := moreHTTPAbs
	moreHTTPAbs = func(output string) (string, error) {
		return filepath.Join(downloadDir, output), nil
	}
	defer func() { moreHTTPAbs = oldAbs }()

	if err := moreHTTPFServe(t, artifactCommand(), "download", "1", "art", "--repo", "alice/demo", "--json"); err != nil {
		t.Fatalf("artifact download with traversal name = %v", err)
	}
	if raw, err := os.ReadFile(filepath.Join(downloadDir, "pwned.txt")); err != nil || string(raw) != "safe artifact body" {
		t.Fatalf("sanitized artifact download = %q, %v", raw, err)
	}
	if _, err := os.Stat(filepath.Join(outsideDir, "pwned.txt")); !os.IsNotExist(err) {
		t.Fatalf("server-controlled artifact name escaped download directory: %v", err)
	}
}
