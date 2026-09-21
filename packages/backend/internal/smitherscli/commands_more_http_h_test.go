package smitherscli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func commandsMoreHTTPHSetConfig(t *testing.T, apiURL string) {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	t.Setenv("SMITHERS_TOKEN", "commands_more_http_h_token")
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commandsMoreHTTPHServe(t *testing.T, cli *incur.Cli, argv ...string) string {
	t.Helper()
	var stdout bytes.Buffer
	if err := cli.ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("ServeWithOptions(%v) returned error: %v\n%s", argv, err, stdout.String())
	}
	return stdout.String()
}

func commandsMoreHTTPHServeWantErr(t *testing.T, cli *incur.Cli, want string, argv ...string) {
	t.Helper()
	var stdout bytes.Buffer
	err := cli.ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout})
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("ServeWithOptions(%v) error = %v, want contains %q\n%s", argv, err, want, stdout.String())
	}
}

func commandsMoreHTTPHWithStdin(t *testing.T, input string, fn func()) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "stdin.txt")
	if err := os.WriteFile(path, []byte(input), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdin
	os.Stdin = file
	t.Cleanup(func() {
		os.Stdin = old
		_ = file.Close()
	})
	fn()
}

type commandsMoreHTTPHRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn commandsMoreHTTPHRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestCommandsMoreHttp_H_CommandSurfaceSuccess(t *testing.T) {
	type seenRequest struct {
		Method string
		Path   string
		Body   map[string]any
	}
	seen := []seenRequest{}
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/alpha/waitlist" {
			if got := r.Header.Get("Authorization"); got != "token commands_more_http_h_token" {
				t.Errorf("Authorization header = %q for %s", got, r.URL.Path)
			}
		}
		var body map[string]any
		if r.Body != nil && r.ContentLength != 0 {
			raw, _ := io.ReadAll(r.Body)
			if len(bytes.TrimSpace(raw)) > 0 {
				_ = json.Unmarshal(raw, &body)
			}
		}
		seen = append(seen, seenRequest{Method: r.Method, Path: r.URL.Path, Body: body})
		w.Header().Set("Content-Type", "application/json")

		switch {
		case r.URL.Path == "/artifact-bytes":
			fmt.Fprint(w, "artifact body")
		case r.URL.Path == "/asset-upload":
			if r.Method != http.MethodPut {
				t.Errorf("asset upload method = %s", r.Method)
			}
			if got := r.Header.Get("Content-Type"); got != "text/plain" {
				t.Errorf("asset upload content-type = %q", got)
			}
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/artifacts/artifact/download"):
			fmt.Fprintf(w, `{"download_url":%q,"name":"artifact.txt","size":13,"content_type":"text/plain"}`, server.URL+"/artifact-bytes")
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/releases/77"):
			fmt.Fprint(w, `{"id":77,"tag_name":"v77"}`)
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/releases/tags/"):
			fmt.Fprint(w, `{"id":78,"tag_name":"tagged"}`)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/releases/77/assets"):
			fmt.Fprintf(w, `{"upload_url":%q,"asset":{"id":88}}`, server.URL+"/asset-upload")
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPut:
			fmt.Fprint(w, `{"ok":true}`)
		case r.Method == http.MethodGet:
			fmt.Fprint(w, `[{"ok":true}]`)
		default:
			fmt.Fprint(w, `{"ok":true,"id":77,"number":9}`)
		}
	}))
	defer server.Close()
	commandsMoreHTTPHSetConfig(t, server.URL)

	commandsMoreHTTPHServe(t, adminCommand(), "user", "list", "--page", "2", "--limit", "5", "--json")
	commandsMoreHTTPHServe(t, adminCommand(), "user", "create", "--username", "new-user", "--email", "new@example.com", "--json")
	commandsMoreHTTPHServe(t, adminCommand(), "user", "disable", "new-user", "--json")
	commandsMoreHTTPHServe(t, adminCommand(), "user", "delete", "new-user", "--json")
	commandsMoreHTTPHServe(t, adminCommand(), "runner", "list", "--json")
	commandsMoreHTTPHServe(t, adminCommand(), "runs", "list", "--repo", "acme/repo", "--page", "3", "--limit", "7", "--json")
	commandsMoreHTTPHServe(t, adminCommand(), "health", "--json")

	commandsMoreHTTPHServe(t, betaCommand(), "waitlist", "join", "--email", " wait@example.com ", "--note", "note", "--source", " cli ", "--json")
	commandsMoreHTTPHServe(t, betaCommand(), "waitlist", "list", "--status", "approved", "--page", "2", "--per-page", "9", "--json")
	commandsMoreHTTPHServe(t, betaCommand(), "waitlist", "approve", "--email", " wait@example.com ", "--json")
	commandsMoreHTTPHServe(t, betaCommand(), "whitelist", "add", "--type", "email", "--value", " user@example.com ", "--json")
	commandsMoreHTTPHServe(t, betaCommand(), "whitelist", "list", "--json")
	commandsMoreHTTPHServe(t, betaCommand(), "whitelist", "remove", "--type", "email", "--value", " user@example.com ", "--json")

	commandsMoreHTTPHServe(t, orgCommand(), "create", "acme", "--description", "org desc", "--visibility", "private", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "list", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "view", "acme", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "edit", "acme", "--description", "", "--visibility", "limited", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "delete", "acme", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "member", "list", "acme", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "member", "add", "acme", "alice", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "member", "remove", "acme", "alice", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "team", "list", "acme", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "team", "create", "acme", "core", "--description", "team desc", "--permission", "write", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "team", "view", "acme", "core", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "team", "edit", "acme", "core", "--name", "platform", "--description", "", "--permission", "admin", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "team", "delete", "acme", "core", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "team", "member", "list", "acme", "core", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "team", "member", "add", "acme", "core", "bob", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "team", "member", "remove", "acme", "core", "bob", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "team", "repo", "list", "acme", "core", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "team", "repo", "add", "acme", "core", "alice/demo", "--json")
	commandsMoreHTTPHServe(t, orgCommand(), "team", "repo", "remove", "acme", "core", "alice/demo", "--json")
	commandsMoreHTTPHServeWantErr(t, orgCommand(), "Invalid repo format", "team", "repo", "add", "acme", "core", "not-a-repo", "--json")
	commandsMoreHTTPHServeWantErr(t, orgCommand(), "Invalid repo format", "team", "repo", "remove", "acme", "core", "not-a-repo", "--json")

	commandsMoreHTTPHServe(t, webhookCommand(), "create", "--url", "https://hooks.example/push", "--events", "push", "--events", "pull_request", "--active=false", "--repo", "alice/demo", "--json")
	commandsMoreHTTPHWithStdin(t, "webhook-secret", func() {
		commandsMoreHTTPHServe(t, webhookCommand(), "create", "--url", "https://hooks.example/default", "--secret-stdin", "--repo", "alice/demo", "--json")
	})
	commandsMoreHTTPHServe(t, webhookCommand(), "list", "--repo", "alice/demo", "--json")
	commandsMoreHTTPHServe(t, webhookCommand(), "view", "11", "--repo", "alice/demo", "--json")
	commandsMoreHTTPHWithStdin(t, "updated-secret", func() {
		commandsMoreHTTPHServe(t, webhookCommand(), "update", "11", "--url", "https://hooks.example/new", "--events", "push", "--active=false", "--secret-stdin", "--repo", "alice/demo", "--json")
	})
	commandsMoreHTTPHServe(t, webhookCommand(), "delete", "11", "--repo", "alice/demo", "--json")
	commandsMoreHTTPHServe(t, webhookCommand(), "deliveries", "11", "--repo", "alice/demo", "--json")
	commandsMoreHTTPHServe(t, webhookCommand(), "deliveries", "11", "--replay", "delivery 1", "--repo", "alice/demo", "--json")

	commandsMoreHTTPHWithStdin(t, `{"access_token":"linear-access","refresh_token":"linear-refresh"}`, func() {
		commandsMoreHTTPHServe(t, extensionCommand(), "linear", "install", "--credentials-stdin", "--team-id", "team-1", "--team-name", "Platform", "--team-key", "PLAT", "--repo-owner", "alice", "--repo-name", "demo", "--repo-id", "42", "--expires-at", "2026-01-02T03:04:05Z", "--actor-id", "actor-1", "--json")
	})
	commandsMoreHTTPHServe(t, extensionCommand(), "linear", "list", "--json")
	commandsMoreHTTPHServe(t, extensionCommand(), "linear", "remove", "10", "--json")
	commandsMoreHTTPHServe(t, extensionCommand(), "linear", "sync", "10", "--json")
	commandsMoreHTTPHServeWantErr(t, extensionCommand(), "credentials must be provided", "linear", "install", "--team-id", "team-1", "--repo-owner", "alice", "--repo-name", "demo", "--repo-id", "42", "--json")
	commandsMoreHTTPHWithStdin(t, `{"refresh_token":"only-refresh"}`, func() {
		commandsMoreHTTPHServeWantErr(t, extensionCommand(), "invalid Linear OAuth credentials", "linear", "install", "--credentials-stdin", "--team-id", "team-1", "--repo-owner", "alice", "--repo-name", "demo", "--repo-id", "42", "--json")
	})

	commandsMoreHTTPHServe(t, artifactCommand(), "list", "99", "--repo", "alice/demo", "--json")
	outPath := filepath.Join(t.TempDir(), "artifact.txt")
	commandsMoreHTTPHServe(t, artifactCommand(), "download", "99", "artifact", "--repo", "alice/demo", "--output", outPath, "--json")
	if raw, err := os.ReadFile(outPath); err != nil || string(raw) != "artifact body" {
		t.Fatalf("artifact download = %q, %v", raw, err)
	}

	asset := filepath.Join(t.TempDir(), "asset.txt")
	if err := os.WriteFile(asset, []byte("asset body"), 0o600); err != nil {
		t.Fatal(err)
	}

	if len(seen) < 48 {
		t.Fatalf("expected broad command surface to be exercised, saw only %d requests", len(seen))
	}
	var foundUserCreate, foundWebhookSecret, foundLinearInstall bool
	for _, req := range seen {
		if req.Method == http.MethodPost && req.Path == "/api/admin/users" {
			if len(req.Body) != 2 || req.Body["username"] != "new-user" || req.Body["email"] != "new@example.com" {
				t.Fatalf("user create body = %#v, want username and email only", req.Body)
			}
			if _, ok := req.Body["password"]; ok {
				t.Fatal("user create body unexpectedly contained password")
			}
			if _, ok := req.Body["must_change_password"]; ok {
				t.Fatal("user create body unexpectedly contained must_change_password")
			}
			foundUserCreate = true
		}
		if req.Body["secret"] == "webhook-secret" || req.Body["secret"] == "updated-secret" {
			foundWebhookSecret = true
		}
		if req.Body["access_token"] == "linear-access" && req.Body["refresh_token"] == "linear-refresh" {
			foundLinearInstall = true
		}
	}
	if !foundUserCreate || !foundWebhookSecret || !foundLinearInstall {
		t.Fatalf("expected request bodies not observed: user_create=%t webhook=%t linear=%t", foundUserCreate, foundWebhookSecret, foundLinearInstall)
	}
}

func TestCommandsMoreHttp_H_RequestAndTransferErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/empty":
			w.WriteHeader(http.StatusNoContent)
		case "/invalid-json":
			fmt.Fprint(w, `not-json`)
		case "/api/repos/alice/demo/releases/91":
			if r.Method == http.MethodGet {
				fmt.Fprint(w, `{"id":91}`)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		case "/too-large":
			fmt.Fprint(w, "abcdef")
		case "/copy-error":
			w.Header().Set("Content-Length", "99")
			fmt.Fprint(w, "short")
		case "/ok-download":
			fmt.Fprint(w, "ok")
		default:
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		}
	}))
	defer server.Close()
	commandsMoreHTTPHSetConfig(t, server.URL)

	if got, err := unauthenticatedJSONRequest(http.MethodGet, "/empty", nil); err != nil || got != nil {
		t.Fatalf("empty unauthenticated response = (%#v, %v)", got, err)
	}
	if _, err := unauthenticatedJSONRequest(http.MethodGet, "/invalid-json", nil); err == nil {
		t.Fatal("unauthenticatedJSONRequest accepted invalid JSON")
	}

	commandsMoreHTTPHSetConfig(t, "://bad-url")
	if _, err := unauthenticatedJSONRequest(http.MethodGet, "/bad", nil); err == nil {
		t.Fatal("unauthenticatedJSONRequest accepted invalid URL")
	}

	commandsMoreHTTPHSetConfig(t, server.URL)
	oldClient := http.DefaultClient
	t.Cleanup(func() { http.DefaultClient = oldClient })
	http.DefaultClient = &http.Client{Transport: commandsMoreHTTPHRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("forced transport error")
	})}
	if _, err := unauthenticatedJSONRequest(http.MethodGet, "/transport-error", nil); err == nil || !strings.Contains(err.Error(), "forced transport error") {
		t.Fatalf("unauthenticatedJSONRequest transport error = %v", err)
	}
	http.DefaultClient = oldClient

	if err := downloadFileLimit("://bad-url", filepath.Join(t.TempDir(), "out"), 10); err == nil {
		t.Fatal("downloadFileLimit accepted invalid URL")
	}
	if err := downloadFileLimit(server.URL+"/ok-download", t.TempDir(), 10); err == nil {
		t.Fatal("downloadFileLimit created a directory path")
	}
	if err := downloadFileLimit(server.URL+"/too-large", filepath.Join(t.TempDir(), "large"), 3); err == nil || !strings.Contains(err.Error(), "exceeds maximum") {
		t.Fatalf("downloadFileLimit size error = %v", err)
	}
	if err := downloadFileLimit(server.URL+"/copy-error", filepath.Join(t.TempDir(), "short"), 100); err == nil {
		t.Fatal("downloadFileLimit accepted a truncated response")
	}
	out := filepath.Join(t.TempDir(), "ok")
	if err := downloadFileLimit(server.URL+"/ok-download", out, 2); err != nil {
		t.Fatalf("downloadFileLimit success returned error: %v", err)
	}
	if raw, err := os.ReadFile(out); err != nil || string(raw) != "ok" {
		t.Fatalf("downloaded file = %q, %v", raw, err)
	}

}

func TestCommandsMoreHttp_H_CommandErrorBranches(t *testing.T) {
	mode := ""
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fail := func(message string) {
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprintf(w, `{"message":%q}`, message)
		}
		switch mode {
		case "delete-user":
			if r.Method == http.MethodDelete && r.URL.Path == "/api/admin/users/bad" {
				fail("delete user denied")
				return
			}
		case "whitelist-remove":
			if r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/whitelist/") {
				fail("whitelist denied")
				return
			}
		case "org-delete":
			if r.Method == http.MethodDelete && r.URL.Path == "/api/orgs/acme" {
				fail("org delete denied")
				return
			}
		case "member-remove":
			if r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/members/bob") {
				fail("member remove denied")
				return
			}
		case "team-member-remove":
			if r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/teams/core/members/bob") {
				fail("team member remove denied")
				return
			}
		case "team-delete":
			if r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/teams/core") {
				fail("team delete denied")
				return
			}
		case "repo-remove":
			if r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/repos/alice/demo") {
				fail("repo remove denied")
				return
			}
		case "webhook-delete":
			if r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/hooks/12") {
				fail("webhook delete denied")
				return
			}
		case "webhook-view-hook":
			if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/hooks/12") {
				fail("webhook missing")
				return
			}
		case "webhook-view-deliveries":
			if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/deliveries") {
				fail("deliveries denied")
				return
			}
		case "linear-remove":
			if r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/linear/12") {
				fail("linear remove denied")
				return
			}
		case "artifact-api":
			if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/download") {
				fail("artifact API denied")
				return
			}
		case "artifact-unexpected":
			if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/download") {
				fmt.Fprint(w, `["not","object"]`)
				return
			}
		case "artifact-missing-url":
			if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/download") {
				fmt.Fprint(w, `{"name":"artifact"}`)
				return
			}
		case "artifact-bad-download":
			if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/download") {
				fmt.Fprint(w, `{"download_url":"://bad-url","name":"artifact"}`)
				return
			}
		case "release-get-error":
			if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/releases/12") {
				fail("release get denied")
				return
			}
		case "release-get-nonobject":
			if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/releases/12") {
				fmt.Fprint(w, `["not-object"]`)
				return
			}
		case "release-get-no-id":
			if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/releases/12") {
				fmt.Fprint(w, `{"tag_name":"v12"}`)
				return
			}
		case "release-asset-create-error":
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/assets") {
				fail("asset create denied")
				return
			}
		case "release-asset-create-unexpected":
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/assets") {
				fmt.Fprint(w, `["not-object"]`)
				return
			}
		case "release-asset-create-missing":
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/assets") {
				fmt.Fprint(w, `{"upload_url":"","asset":{"id":0}}`)
				return
			}
		case "release-upload-url-bad":
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/assets") {
				fmt.Fprint(w, `{"upload_url":"://bad-url","asset":{"id":55}}`)
				return
			}
		case "release-confirm-error":
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/confirm") {
				fail("confirm denied")
				return
			}
		}
		switch {
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/releases/12"):
			fmt.Fprint(w, `{"id":12,"tag_name":"v12"}`)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/assets"):
			fmt.Fprintf(w, `{"upload_url":%q,"asset":{"id":55}}`, server.URL+"/upload-ok")
		case r.URL.Path == "/upload-ok":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/download"):
			fmt.Fprintf(w, `{"download_url":%q,"name":"artifact"}`, server.URL+"/download-ok")
		case r.URL.Path == "/download-ok":
			fmt.Fprint(w, "ok")
		default:
			fmt.Fprint(w, `{"ok":true}`)
		}
	}))
	defer server.Close()
	commandsMoreHTTPHSetConfig(t, server.URL)

	for _, tc := range []struct {
		mode string
		cli  *incur.Cli
		want string
		argv []string
	}{
		{"delete-user", adminCommand(), "delete user denied", []string{"user", "delete", "bad", "--json"}},
		{"whitelist-remove", betaCommand(), "whitelist denied", []string{"whitelist", "remove", "--type", "email", "--value", "bad@example.com", "--json"}},
		{"org-delete", orgCommand(), "org delete denied", []string{"delete", "acme", "--json"}},
		{"member-remove", orgCommand(), "member remove denied", []string{"member", "remove", "acme", "bob", "--json"}},
		{"team-delete", orgCommand(), "team delete denied", []string{"team", "delete", "acme", "core", "--json"}},
		{"team-member-remove", orgCommand(), "team member remove denied", []string{"team", "member", "remove", "acme", "core", "bob", "--json"}},
		{"repo-remove", orgCommand(), "repo remove denied", []string{"team", "repo", "remove", "acme", "core", "alice/demo", "--json"}},
		{"webhook-delete", webhookCommand(), "webhook delete denied", []string{"delete", "12", "--repo", "alice/demo", "--json"}},
		{"webhook-view-hook", webhookCommand(), "webhook missing", []string{"view", "12", "--repo", "alice/demo", "--json"}},
		{"webhook-view-deliveries", webhookCommand(), "deliveries denied", []string{"view", "12", "--repo", "alice/demo", "--json"}},
		{"linear-remove", extensionCommand(), "linear remove denied", []string{"linear", "remove", "12", "--json"}},
		{"artifact-api", artifactCommand(), "artifact API denied", []string{"download", "1", "artifact", "--repo", "alice/demo", "--json"}},
		{"artifact-unexpected", artifactCommand(), "unexpected artifact", []string{"download", "1", "artifact", "--repo", "alice/demo", "--json"}},
		{"artifact-missing-url", artifactCommand(), "download_url", []string{"download", "1", "artifact", "--repo", "alice/demo", "--json"}},
		{"artifact-bad-download", artifactCommand(), "missing protocol", []string{"download", "1", "artifact", "--repo", "alice/demo", "--json"}},
	} {
		mode = tc.mode
		commandsMoreHTTPHServeWantErr(t, tc.cli, tc.want, tc.argv...)
	}

	asset := filepath.Join(t.TempDir(), "asset.txt")
	if err := os.WriteFile(asset, []byte("asset"), 0o600); err != nil {
		t.Fatal(err)
	}
	dirAsset := t.TempDir()
	for _, tc := range []struct {
		mode string
		want string
		file string
	}{
		{"", "no such file", filepath.Join(t.TempDir(), "missing")},
		{"", "not a file", dirAsset},
		{"release-asset-create-error", "asset create denied", asset},
		{"release-asset-create-unexpected", "unexpected release asset upload response", asset},
		{"release-asset-create-missing", "did not include upload_url", asset},
		{"release-upload-url-bad", "missing protocol", asset},
		{"release-confirm-error", "confirm denied", asset},
	} {
		mode = tc.mode
	}

	mode = ""
	parentFile := filepath.Join(t.TempDir(), "parent-file")
	if err := os.WriteFile(parentFile, []byte("not-dir"), 0o600); err != nil {
		t.Fatal(err)
	}
	commandsMoreHTTPHServeWantErr(t, artifactCommand(), "not a directory", "download", "1", "artifact", "--repo", "alice/demo", "--output", filepath.Join(parentFile, "child"), "--json")

	mode = ""
	commandsMoreHTTPHServeWantErr(t, artifactCommand(), "Invalid repo format", "list", "1", "--repo", "bad", "--json")
	commandsMoreHTTPHServeWantErr(t, webhookCommand(), "Invalid repo format", "create", "--url", "https://example.test", "--repo", "bad", "--json")

	commandsMoreHTTPHWithStdin(t, "", func() {
		commandsMoreHTTPHServeWantErr(t, extensionCommand(), "no Linear OAuth credentials", "linear", "install", "--credentials-stdin", "--team-id", "t", "--repo-owner", "alice", "--repo-name", "demo", "--repo-id", "1", "--json")
	})
}
