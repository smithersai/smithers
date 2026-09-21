package smitherscli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func clientCovSetConfig(t *testing.T, apiURL string) {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func clientCovInstallRemoteTools(t *testing.T) string {
	t.Helper()
	binDir := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	jj := `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'jj 0.33.0\n'
  exit 0
fi
if [ "$1" = "git" ] && [ "$2" = "remote" ] && [ "$3" = "list" ]; then
  printf 'upstream git@ssh.example.com:team/fallback.git\norigin https://example.com/team/origin.git\n'
  exit 0
fi
exit 1
`
	git := `#!/bin/sh
if [ "$1" = "remote" ] && [ "$2" = "-v" ]; then
  printf 'backup https://example.com/team/gitfallback.git (fetch)\n'
  exit 0
fi
exit 1
`
	if err := os.WriteFile(filepath.Join(binDir, "jj"), []byte(jj), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "git"), []byte(git), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	return binDir
}

func TestClient_Cov_APIErrorRequireJjAndCommandTimeout(t *testing.T) {
	apiErr := (&APIError{Method: "GET", Path: "/api/cov", Status: http.StatusTeapot, Detail: "short and stout"}).Error()
	if !strings.Contains(apiErr, "GET /api/cov -> 418: short and stout") {
		t.Fatalf("APIError.Error() = %q", apiErr)
	}
	binDir := clientCovInstallRemoteTools(t)
	// This branch asserts that a jj answering --version is accepted. Spawning
	// /bin/sh on a saturated CI host has taken longer than the production
	// bound, so the bound itself is covered by TestRequireJj_TimesOutSlowJj
	// and this call gets a wide one.
	clientCovSetRequireJjTimeout(t, time.Minute)
	start := time.Now()
	if err := RequireJj(); err != nil {
		elapsed := time.Since(start)
		directStart := time.Now()
		out, directErr := exec.Command(filepath.Join(binDir, "jj"), "--version").Output()
		t.Fatalf("RequireJj with fake jj returned error after %s: %v\ndirect exec of %s/jj --version took %s: out=%q err=%v",
			elapsed.Round(time.Millisecond), err, binDir, time.Since(directStart).Round(time.Millisecond), out, directErr)
	}
	out, err := runCommandWithTimeout(exec.Command("jj", "--version"), time.Second)
	if err != nil || !strings.Contains(out, "jj 0.33.0") {
		t.Fatalf("runCommandWithTimeout success = (%q, %v)", out, err)
	}
	clientCovAssertCommandTimeout(t)

	t.Setenv("PATH", t.TempDir())
	if err := RequireJj(); err == nil || !strings.Contains(err.Error(), "jj (Jujutsu) is not installed") {
		t.Fatalf("RequireJj without jj = %v", err)
	}
}

func clientCovSetRequireJjTimeout(t *testing.T, timeout time.Duration) {
	t.Helper()
	previous := requireJjTimeout
	requireJjTimeout = timeout
	t.Cleanup(func() { requireJjTimeout = previous })
}

// A jj that never answers --version inside the bound is reported as missing,
// and RequireJj returns once the bound elapses instead of waiting for the
// child: the child sleeps far longer than the assertion allows.
func TestRequireJj_TimesOutSlowJj(t *testing.T) {
	binDir := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	slow := "#!/bin/sh\nexec /bin/sleep 120\n"
	if err := os.WriteFile(filepath.Join(binDir, "jj"), []byte(slow), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	clientCovSetRequireJjTimeout(t, 100*time.Millisecond)
	start := time.Now()
	err := RequireJj()
	elapsed := time.Since(start)
	if err == nil || !strings.Contains(err.Error(), "jj (Jujutsu) is not installed") {
		t.Fatalf("RequireJj with a jj that never answers = %v", err)
	}
	if elapsed > time.Minute {
		t.Fatalf("RequireJj waited %s for a jj that sleeps 120s; the bound did not apply", elapsed.Round(time.Millisecond))
	}
}

func clientCovAssertCommandTimeout(t *testing.T) {
	t.Helper()
	cmd := exec.Command("/bin/sh", "-c", "exec /bin/sleep 1")
	_, err := runCommandWithTimeout(cmd, 100*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected timeout error, got %v", err)
	}
	if cmd.ProcessState == nil {
		t.Fatal("timed-out child was not reaped before returning")
	}
}

func TestCommandTimeoutBeforeProcessCanFinish(t *testing.T) {
	for i := 0; i < 20; i++ {
		cmd := exec.Command("/bin/sh", "-c", "exec /bin/sleep 1")
		_, err := runCommandWithTimeout(cmd, 0)
		if err == nil || cmd.ProcessState == nil {
			t.Fatalf("immediate timeout must cancel and reap the process: %v", err)
		}
	}
	if _, err := runCommandWithTimeout(exec.Command("/does-not-exist"), 0); err == nil {
		t.Fatal("process startup failure must be returned")
	}
}

func TestClient_Cov_RepoParsingAndResolution(t *testing.T) {
	clientCovSetConfig(t, "https://api.example.com")
	if got := BuildCloneURL("alice", "demo", GitProtocolSSH, "https://api.example.com"); got != "git@ssh.example.com:alice/demo.git" {
		t.Fatalf("BuildCloneURL ssh = %q", got)
	}
	if got := BuildCloneURL("alice", "demo", GitProtocolHTTPS, "https://api.example.com"); got != "https://example.com/alice/demo.git" {
		t.Fatalf("BuildCloneURL https = %q", got)
	}

	if owner, repo, ok := parseOwnerRepoRef("alice/demo"); !ok || owner != "alice" || repo != "demo" {
		t.Fatalf("parseOwnerRepoRef valid = (%q, %q, %t)", owner, repo, ok)
	}
	for _, bad := range []string{"alice", "alice/", "/demo", "a/b/c"} {
		if _, _, ok := parseOwnerRepoRef(bad); ok {
			t.Fatalf("parseOwnerRepoRef(%q) unexpectedly succeeded", bad)
		}
	}

	for _, raw := range []string{
		"https://example.com/alice/demo.git",
		"git@ssh.example.com:alice/demo.git",
		"ssh://ssh.example.com:alice/demo.git",
	} {
		owner, repo, ok := parseRepoFromURL(raw, "example.com")
		if !ok || owner != "alice" || repo != "demo" {
			t.Fatalf("parseRepoFromURL(%q) = (%q, %q, %t)", raw, owner, repo, ok)
		}
	}
	if owner, repo, ok := parseRepoFromURL("https://smithers.sh/local/demo.git", "localhost"); !ok || owner != "local" || repo != "demo" {
		t.Fatalf("loopback parseRepoFromURL = (%q, %q, %t)", owner, repo, ok)
	}
	if _, _, ok := parseRepoFromURL("https://evil.example.com/alice/demo.git", "example.com"); ok {
		t.Fatal("parseRepoFromURL accepted untrusted host")
	}

	owner, repo, cloneURL, err := ResolveRepoCloneTarget("alice/demo", GitProtocolHTTPS, "https://api.example.com/api")
	if err != nil || owner != "alice" || repo != "demo" || cloneURL != "https://example.com/alice/demo.git" {
		t.Fatalf("ResolveRepoCloneTarget owner/repo = (%q, %q, %q, %v)", owner, repo, cloneURL, err)
	}
	owner, repo, cloneURL, err = ResolveRepoCloneTarget("git@ssh.example.com:alice/demo.git", GitProtocolSSH, "https://api.example.com")
	if err != nil || owner != "alice" || repo != "demo" || cloneURL != "git@ssh.example.com:alice/demo.git" {
		t.Fatalf("ResolveRepoCloneTarget URL = (%q, %q, %q, %v)", owner, repo, cloneURL, err)
	}
	if _, _, _, err = ResolveRepoCloneTarget("not-a-repo", GitProtocolSSH, "https://api.example.com"); err == nil {
		t.Fatal("ResolveRepoCloneTarget accepted invalid repo")
	}

	owner, repo, err = ResolveRepoRef("alice/demo")
	if err != nil || owner != "alice" || repo != "demo" {
		t.Fatalf("ResolveRepoRef override = (%q, %q, %v)", owner, repo, err)
	}
	clientCovInstallRemoteTools(t)
	owner, repo, err = ResolveRepoRef("")
	if err != nil || owner != "team" || repo != "origin" {
		t.Fatalf("ResolveRepoRef detected remote = (%q, %q, %v)", owner, repo, err)
	}
	t.Setenv("PATH", t.TempDir())
	if _, _, err = ResolveRepoRef(""); err == nil || !strings.Contains(err.Error(), "Could not determine repository") {
		t.Fatalf("ResolveRepoRef missing remotes = %v", err)
	}
}

func TestClient_Cov_APIRequestListAndPagination(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.RequestURI())
		if got := r.Header.Get("Authorization"); got != "token client_cov_token" {
			t.Errorf("Authorization header = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/ok":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("invalid JSON body: %v", err)
			}
			if body["name"] != "cov" {
				t.Errorf("body name = %#v", body["name"])
			}
			fmt.Fprint(w, `{"ok":true}`)
		case r.Method == http.MethodDelete && r.URL.Path == "/empty":
			w.WriteHeader(http.StatusNoContent)
		case r.URL.Path == "/message-error":
			w.WriteHeader(http.StatusTeapot)
			fmt.Fprint(w, `{"message":"teapot"}`)
		case r.URL.Path == "/text-error":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `plain failure`)
		case r.URL.Path == "/bad-json":
			fmt.Fprint(w, `not-json`)
		case r.URL.Path == "/list" && r.URL.Query().Get("cursor") == "":
			w.Header().Set("Link", `<`+serverURLPlaceholder(r)+`/list?cursor=n2>; rel="next"`)
			fmt.Fprint(w, `[{"id":1}]`)
		case r.URL.Path == "/list" && r.URL.Query().Get("cursor") == "n2":
			fmt.Fprint(w, `[{"id":2}]`)
		case r.URL.Path == "/nocontent":
			w.Header().Set("Link", `<http://example.test/items?cursor=after>; rel="next"`)
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		}
	}))
	defer server.Close()

	token := &ResolvedAuthToken{AuthTarget: AuthTarget{APIURL: server.URL, Host: "example.test"}, Token: "client_cov_token"}
	result, err := APIRequest(http.MethodPost, "/ok", map[string]any{"name": "cov"}, token)
	if err != nil {
		t.Fatalf("APIRequest success returned error: %v", err)
	}
	if objectValue(result)["ok"] != true {
		t.Fatalf("APIRequest decoded %#v", result)
	}
	if result, err = APIRequest(http.MethodDelete, "/empty", nil, token); err != nil || result != nil {
		t.Fatalf("APIRequest no content = (%#v, %v)", result, err)
	}
	if _, err = APIRequest(http.MethodGet, "/message-error", nil, token); err == nil || !strings.Contains(err.Error(), "teapot") {
		t.Fatalf("APIRequest JSON error = %v", err)
	}
	if _, err = APIRequest(http.MethodGet, "/text-error", nil, token); err == nil || !strings.Contains(err.Error(), "plain failure") {
		t.Fatalf("APIRequest text error = %v", err)
	}
	if _, err = APIRequest(http.MethodGet, "/bad-json", nil, token); err == nil {
		t.Fatal("APIRequest accepted invalid JSON response")
	}
	if _, err = APIRequest(http.MethodPost, "/ok", map[string]any{"bad": func() {}}, token); err == nil {
		t.Fatal("APIRequest accepted an unmarshalable request body")
	}

	data, next, err := APIList("/list", token)
	if err != nil || next != "n2" || len(arrayValue(data)) != 1 {
		t.Fatalf("APIList first page = (%#v, %q, %v)", data, next, err)
	}
	data, next, err = APIList("/nocontent", token)
	if err != nil || next != "after" || len(arrayValue(data)) != 0 {
		t.Fatalf("APIList no content = (%#v, %q, %v)", data, next, err)
	}
	all, err := APIListAll(func(cursor string) string {
		if cursor == "" {
			return "/list"
		}
		return "/list?cursor=" + cursor
	}, token)
	if err != nil || len(all) != 2 {
		t.Fatalf("APIListAll = (%#v, %v)", all, err)
	}
	if _, _, err = APIList("/message-error", token); err == nil || !strings.Contains(err.Error(), "teapot") {
		t.Fatalf("APIList error = %v", err)
	}

	if got := escapePathSegment("a b/c+?"); got != "a%20b%2Fc%2B%3F" {
		t.Fatalf("escapePathSegment = %q", got)
	}
	if got := ParseNextCursor(`<http://example.test/items?page=1>; rel="prev", <http://example.test/items?cursor=next>; rel="next"`); got != "next" {
		t.Fatalf("ParseNextCursor = %q", got)
	}
	if got := ParseNextCursor(`<://bad>; rel="next"`); got != "" {
		t.Fatalf("ParseNextCursor invalid URL = %q", got)
	}
	if len(seen) == 0 {
		t.Fatal("test server saw no requests")
	}
}

func serverURLPlaceholder(r *http.Request) string {
	if r.TLS != nil {
		return "https://" + r.Host
	}
	return "http://" + r.Host
}

func TestClient_Cov_APIRequestWithoutTokenUsesAuthResolution(t *testing.T) {
	clientCovSetConfig(t, "http://127.0.0.1:1")
	t.Setenv("SMITHERS_TOKEN", "")
	if _, err := APIRequest(http.MethodGet, "/api/missing", nil, nil); err == nil || !strings.Contains(err.Error(), "no token found") {
		t.Fatalf("APIRequest without token = %v", err)
	}
	if _, _, err := APIList("/api/missing", nil); err == nil || !strings.Contains(err.Error(), "no token found") {
		t.Fatalf("APIList without token = %v", err)
	}
	errorServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, `{"message":"list failed"}`)
	}))
	defer errorServer.Close()
	if _, err := APIListAll(func(string) string { return "/api/missing" }, &ResolvedAuthToken{AuthTarget: AuthTarget{APIURL: errorServer.URL}, Token: "x"}); err == nil || !strings.Contains(err.Error(), "list failed") {
		t.Fatalf("APIListAll error = %v", err)
	}
}
