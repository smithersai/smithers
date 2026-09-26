package smitherscli

import (
	"encoding/json"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// pushFixture is a Smithers API stand-in: GET /api/user answers user 42 and
// the smart-HTTP routes are real `git http-backend` over a bare repository.
type pushFixture struct {
	api        *httptest.Server
	bare       string
	mu         sync.Mutex
	receives   int
	unauthed   int
	originMain string
	public     bool
	renewed    []string
}

func newPushFixture(t *testing.T) *pushFixture {
	t.Helper()
	gitBin, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git is not installed")
	}
	root := t.TempDir()
	f := &pushFixture{bare: filepath.Join(root, "alice", "demo.git")}
	pushGit(t, "", "init", "--bare", "--initial-branch=main", f.bare)
	pushGit(t, f.bare, "config", "http.receivepack", "true")
	seed := t.TempDir()
	pushGit(t, seed, "init", "--initial-branch=main")
	writePushFile(t, seed, "README.md", "cloud main\n")
	pushGit(t, seed, "add", ".")
	pushGit(t, seed, "commit", "-m", "cloud main")
	pushGit(t, seed, "push", f.bare, "main")
	f.originMain = pushGit(t, f.bare, "rev-parse", "refs/heads/main")

	backend := &cgi.Handler{
		Path: gitBin,
		Args: []string{"http-backend"},
		Env:  []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1"},
	}
	f.api = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := "Bearer push-token"
		if strings.HasPrefix(r.URL.Path, "/api/") {
			want = "token push-token" // the CLI's API client spelling
		}
		if r.Header.Get("Authorization") != want {
			f.mu.Lock()
			f.unauthed++
			f.mu.Unlock()
			w.Header().Set("WWW-Authenticate", `Basic realm="Smithers Git"`)
			http.Error(w, "authentication required", http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/api/user" {
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 42, "username": "alice"})
			return
		}
		if r.URL.Path == "/api/repos/alice/demo" {
			_ = json.NewEncoder(w).Encode(map[string]any{"is_public": f.public})
			return
		}
		if r.URL.Path == "/api/repos/alice/demo/user-refs/renew" && r.Method == http.MethodPost {
			var body struct{ Name string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.mu.Lock()
			f.renewed = append(f.renewed, body.Name)
			f.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"name": body.Name, "expires_at": "2026-10-26T00:00:00Z"})
			return
		}
		if r.URL.Path == "/api/repos/alice/demo/user-refs" && r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{"refs": []any{}, "limit": 20, "ttl_seconds": 2592000})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/git-receive-pack") {
			f.mu.Lock()
			f.receives++
			f.mu.Unlock()
		}
		backend.ServeHTTP(w, r)
	}))
	t.Cleanup(f.api.Close)
	commandsRepoCovSetConfig(t, f.api.URL)
	t.Setenv("SMITHERS_TOKEN", "push-token")
	return f
}

func pushGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=T", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=T", "GIT_COMMITTER_EMAIL=t@example.com", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func writePushFile(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (f *pushFixture) remoteRefs(t *testing.T) map[string]string {
	t.Helper()
	refs := map[string]string{}
	for _, line := range strings.Split(pushGit(t, f.bare, "for-each-ref", "--format=%(refname) %(objectname)"), "\n") {
		if name, sha, ok := strings.Cut(line, " "); ok {
			refs[name] = sha
		}
	}
	return refs
}

func repoPush(t *testing.T, argv ...string) map[string]any {
	t.Helper()
	out := commandsRepoZServe(t, append([]string{"push", "--format", "json"}, argv...)...)
	var result map[string]any
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("push output %q: %v", out, err)
	}
	return result
}

// A git checkout's HEAD lands on the caller's own ref, never a bookmark;
// pushing again is a no-op; a new commit moves only that ref; --delete
// removes it.
func TestRepoPush_GitCheckoutIsIdempotentAndNamespaced(t *testing.T) {
	f := newPushFixture(t)
	checkout := t.TempDir()
	pushGit(t, checkout, "init", "--initial-branch=main")
	pushGit(t, checkout, "remote", "add", "origin", "git@github.com:alice/demo.git")
	writePushFile(t, checkout, "local.txt", "local work\n")
	pushGit(t, checkout, "add", ".")
	pushGit(t, checkout, "commit", "-m", "local work")
	head := pushGit(t, checkout, "rev-parse", "HEAD")
	commandsRepoZChdir(t, checkout)

	first := repoPush(t)
	if first["ref"] != "refs/smithers/users/42/head" || first["commit"] != head || first["updated"] != true ||
		first["repository"] != "alice/demo" || first["previous"] != nil || first["uncommitted"] != false {
		t.Fatalf("first push = %#v", first)
	}
	refs := f.remoteRefs(t)
	if refs["refs/smithers/users/42/head"] != head || refs["refs/heads/main"] != f.originMain || len(refs) != 2 {
		t.Fatalf("remote refs after push = %#v", refs)
	}

	if first["expires_at"] != "2026-10-26T00:00:00Z" {
		t.Fatalf("first push expiry = %#v", first["expires_at"])
	}

	// An unchanged commit sends git nothing but still renews the expiry.
	second := repoPush(t)
	if second["updated"] != false || second["previous"] != head || f.receives != 1 || len(f.renewed) != 2 {
		t.Fatalf("second push = %#v after %d receive-packs, renewals %v", second, f.receives, f.renewed)
	}
	if listed := repoPush(t, "--list"); listed["limit"] != float64(20) {
		t.Fatalf("list = %#v", listed)
	}

	writePushFile(t, checkout, "local.txt", "more\n")
	uncommitted := repoPush(t)
	if uncommitted["uncommitted"] != true || uncommitted["updated"] != false {
		t.Fatalf("dirty push = %#v", uncommitted)
	}
	pushGit(t, checkout, "commit", "-am", "more")
	next := pushGit(t, checkout, "rev-parse", "HEAD")
	third := repoPush(t, "--name", "feature/x")
	if third["ref"] != "refs/smithers/users/42/feature/x" || third["commit"] != next {
		t.Fatalf("named push = %#v", third)
	}
	pushGit(t, checkout, "commit", "--amend", "-m", "rewritten")
	rewritten := pushGit(t, checkout, "rev-parse", "HEAD")
	if moved := repoPush(t); moved["previous"] != head || moved["commit"] != rewritten || moved["updated"] != true {
		t.Fatalf("rewritten push = %#v", moved)
	}
	refs = f.remoteRefs(t)
	if refs["refs/smithers/users/42/head"] != rewritten || refs["refs/smithers/users/42/feature/x"] != next ||
		refs["refs/heads/main"] != f.originMain {
		t.Fatalf("remote refs = %#v", refs)
	}

	if deleted := repoPush(t, "--delete"); deleted["deleted"] != true {
		t.Fatalf("delete = %#v", deleted)
	}
	if again := repoPush(t, "--delete"); again["deleted"] != false {
		t.Fatalf("second delete = %#v", again)
	}
	if _, ok := f.remoteRefs(t)["refs/smithers/users/42/head"]; ok {
		t.Fatal("deleted ref is still on the remote")
	}
	if f.unauthed != 0 {
		t.Fatalf("%d requests arrived without the bearer", f.unauthed)
	}
}

// A jj checkout pushes @- by default and @ (with its uncommitted edits) on
// --working-copy, from jj's own git store when it is not colocated.
func TestRepoPush_JjCheckoutPushesCommittedWorkUnlessAsked(t *testing.T) {
	if _, err := exec.LookPath("jj"); err != nil {
		t.Skip("jj is not installed")
	}
	f := newPushFixture(t)
	root := t.TempDir()
	jjConfig := filepath.Join(root, "jj-config.toml")
	if err := os.WriteFile(jjConfig, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JJ_CONFIG", jjConfig)
	t.Setenv("JJ_USER", "Test")
	t.Setenv("JJ_EMAIL", "test@example.com")
	checkout := filepath.Join(root, "repo")
	if err := os.MkdirAll(checkout, 0o755); err != nil {
		t.Fatal(err)
	}
	jj := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("jj", args...)
		cmd.Dir = checkout
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("jj %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	jj("git", "init", "--no-colocate")
	jj("git", "remote", "add", "origin", "https://github.com/alice/demo.git")
	commandsRepoZChdir(t, checkout)
	// Nothing committed: @- is jj's all-zero root, which git would read as a delete.
	commandsRepoZServeErr(t, "root commit", "push")
	writePushFile(t, checkout, "committed.txt", "done\n")
	jj("commit", "-m", "committed work")
	writePushFile(t, checkout, "wip.txt", "in progress\n")
	commandsRepoZChdir(t, checkout)

	committed := repoPush(t)
	if committed["commit"] != jj("log", "-r", "@-", "--no-graph", "-T", "commit_id") {
		t.Fatalf("default push = %#v", committed)
	}
	working := repoPush(t, "--working-copy")
	if working["commit"] != jj("log", "-r", "@", "--no-graph", "-T", "commit_id") || working["updated"] != true {
		t.Fatalf("working-copy push = %#v", working)
	}
	if f.remoteRefs(t)["refs/smithers/users/42/head"] != working["commit"] {
		t.Fatal("the working-copy commit is not on the remote")
	}
	if f.remoteRefs(t)["refs/heads/main"] != f.originMain {
		t.Fatal("main moved")
	}
	f.public = true
	commandsRepoZServeErr(t, "refused on public alice/demo", "push", "--working-copy")
	if deleted := repoPush(t, "--delete"); deleted["deleted"] != true {
		t.Fatalf("jj delete = %#v", deleted)
	}
	if _, ok := f.remoteRefs(t)["refs/smithers/users/42/head"]; ok {
		t.Fatal("deleted ref is still on the remote")
	}
}

// The bearer is scoped to the API origin and never follows a redirect.
func TestRepoPush_TokenNeverFollowsARedirect(t *testing.T) {
	var leaked []string
	var mu sync.Mutex
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		leaked = append(leaked, r.Header.Get("Authorization"))
		mu.Unlock()
		http.Error(w, "no", http.StatusNotFound)
	}))
	t.Cleanup(elsewhere.Close)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/user" {
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 42})
			return
		}
		http.Redirect(w, r, elsewhere.URL+r.URL.RequestURI(), http.StatusFound)
	}))
	t.Cleanup(api.Close)
	commandsRepoCovSetConfig(t, api.URL)
	t.Setenv("SMITHERS_TOKEN", "push-token")
	checkout := t.TempDir()
	pushGit(t, checkout, "init", "--initial-branch=main")
	writePushFile(t, checkout, "a.txt", "a\n")
	pushGit(t, checkout, "add", ".")
	pushGit(t, checkout, "commit", "-m", "a")
	commandsRepoZChdir(t, checkout)
	commandsRepoZServeErr(t, "", "push", "--repo", "alice/demo")
	for _, header := range leaked {
		if header != "" {
			t.Fatalf("the redirect target received %q", header)
		}
	}
}

func TestRepoPush_Refusals(t *testing.T) {
	newPushFixture(t)
	checkout := t.TempDir()
	pushGit(t, checkout, "init", "--initial-branch=main")
	commandsRepoZChdir(t, checkout)
	commandsRepoZServeErr(t, "not a valid ref name", "push", "--repo", "alice/demo", "--name", "../main")
	commandsRepoZServeErr(t, "not a valid ref name", "push", "--repo", "alice/demo", "--name", "a//b")
	commandsRepoZServeErr(t, "not a valid ref name", "push", "--repo", "alice/demo", "--name", "head.lock")
	commandsRepoZServeErr(t, "HEAD", "push", "--repo", "alice/demo")
	commandsRepoZServeErr(t, "--working-copy needs a jj checkout", "push", "--repo", "alice/demo", "--working-copy")
	commandsRepoZServeErr(t, "Could not determine repository", "push")
	t.Setenv("SMITHERS_TOKEN", "wrong")
	commandsRepoZServeErr(t, "", "push", "--repo", "alice/demo")
}
