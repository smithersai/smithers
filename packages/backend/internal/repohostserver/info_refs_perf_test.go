package repohostserver

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The ref advertisement is the first thing every clone asks for, and CI fans
// out dozens of clones of the same repository at once. It must therefore cost
// git-backend work only: opening the jj repo and re-exporting its bookmarks per
// request made a full-history repository (~9k commits, ~300 bookmarks) take
// tens of seconds and blew the API's 30s proxy timeout under parallel clones.
//
// syntheticAdvertisementRepo builds a repository of that shape directly with
// `git fast-import` (fast: no jj, no per-commit process) and fakes the jj
// operation-head file the export cache keys on.
const (
	advertisementBenchCommits   = 1000
	advertisementBenchBookmarks = 300

	// The stand-in cost of one jj export. Real exports on a full-history repo
	// are far more expensive; this only has to be big enough that a
	// per-request export would be unmistakable in the assertions below.
	syntheticExportCost = 200 * time.Millisecond

	// Budget for one advertisement. The measured git-only path is ~10ms; a
	// second is two orders of magnitude of headroom and still catches any
	// regression that puts jj work back on the read path.
	advertisementBudget = time.Second
)

type advertisementFixture struct {
	srv      *Server
	handler  http.Handler
	repoPath string
	lastRef  string
	exports  *atomic.Int64
}

// writeOpHead writes a fake jj operation head, standing in for the file jj
// writes when it commits a transaction.
func writeOpHead(t testing.TB, repoPath, id string) {
	t.Helper()
	dir := filepath.Join(repoPath, ".jj", "repo", "op_heads", "heads")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir op_heads: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read op_heads: %v", err)
	}
	for _, entry := range entries {
		if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil {
			t.Fatalf("remove stale op head: %v", err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, id), nil, 0o644); err != nil {
		t.Fatalf("write op head: %v", err)
	}
}

// fastImportStream renders a fast-import stream with a linear history and a
// bookmark fan-out over it.
func fastImportStream(commits, bookmarks int) string {
	var b strings.Builder
	for i := 1; i <= commits; i++ {
		fmt.Fprintf(&b, "commit refs/heads/main\nmark :%d\n", i)
		fmt.Fprintf(&b, "author Bench <bench@example.com> %d +0000\n", 1600000000+i)
		fmt.Fprintf(&b, "committer Bench <bench@example.com> %d +0000\n", 1600000000+i)
		msg := fmt.Sprintf("commit %d", i)
		fmt.Fprintf(&b, "data %d\n%s\n", len(msg), msg)
		if i > 1 {
			fmt.Fprintf(&b, "from :%d\n", i-1)
		}
		content := fmt.Sprintf("revision %d\n", i)
		fmt.Fprintf(&b, "M 100644 inline dir%d/file%d.txt\ndata %d\n%s", i%10, i%50, len(content), content)
	}
	for n := 0; n < bookmarks; n++ {
		fmt.Fprintf(&b, "reset refs/heads/topic-%03d\nfrom :%d\n", n, (n*7)%commits+1)
	}
	b.WriteString("done\n")
	return b.String()
}

func newAdvertisementFixture(t testing.TB, commits, bookmarks int, exportCost time.Duration) *advertisementFixture {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not on PATH; the advertisement path needs a real git")
	}

	exports := &atomic.Int64{}
	mock := &mockFFI{exportGitRefsFn: func(string) error {
		exports.Add(1)
		time.Sleep(exportCost)
		return nil
	}}

	cfg := Config{StoragePath: t.TempDir(), AuthToken: testAuthToken, PushHookCallbackToken: "test-push-callback-token"}
	srv, err := NewWithFFI(cfg, mock)
	if err != nil {
		t.Fatalf("NewWithFFI: %v", err)
	}

	repoPath := cfg.RepoPath("alice", "demo")
	gitDir := cfg.GitBackendPath("alice", "demo")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatalf("mkdir git dir: %v", err)
	}
	if out, err := exec.Command("git", "init", "--bare", "-q", gitDir).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, out)
	}
	cmd := exec.Command("git", "--git-dir", gitDir, "fast-import", "--quiet")
	cmd.Stdin = strings.NewReader(fastImportStream(commits, bookmarks))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git fast-import: %v: %s", err, out)
	}
	writeOpHead(t, repoPath, strings.Repeat("a", 64))

	return &advertisementFixture{
		srv:      srv,
		handler:  srv.Handler(),
		repoPath: repoPath,
		lastRef:  fmt.Sprintf("refs/heads/topic-%03d", bookmarks-1),
		exports:  exports,
	}
}

func (f *advertisementFixture) advertise(t testing.TB) time.Duration {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/repos/alice/demo/git/info-refs?service=git-upload-pack", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	start := time.Now()
	f.handler.ServeHTTP(w, req)
	elapsed := time.Since(start)
	if w.Code != http.StatusOK {
		t.Fatalf("info-refs: expected 200, got %d; body=%s", w.Code, w.Body.String())
	}
	if body := w.Body.String(); !strings.Contains(body, f.lastRef) {
		if len(body) > 200 {
			body = body[:200]
		}
		t.Fatalf("advertisement is missing %s; body prefix=%q", f.lastRef, body)
	}
	return elapsed
}

// TestInfoRefsServesLargeRepoFromGitBackend is the regression guard: once the
// git backend is in sync, every further advertisement of an unchanged
// repository must be served without touching jj, well inside one second.
func TestInfoRefsServesLargeRepoFromGitBackend(t *testing.T) {
	f := newAdvertisementFixture(t, advertisementBenchCommits, advertisementBenchBookmarks, syntheticExportCost)

	if first := f.advertise(t); first > 5*time.Second {
		t.Fatalf("first advertisement took %s", first)
	}
	if got := f.exports.Load(); got != 1 {
		t.Fatalf("expected exactly one export to bring the git backend in sync, got %d", got)
	}

	for i := 0; i < 20; i++ {
		if elapsed := f.advertise(t); elapsed > advertisementBudget {
			t.Fatalf("advertisement %d took %s, budget is %s", i, elapsed, advertisementBudget)
		}
	}
	if got := f.exports.Load(); got != 1 {
		t.Fatalf("repeat advertisements re-exported refs: %d exports", got)
	}
}

// TestInfoRefsParallelClonesDoNotSerialize models the cloud CI fan-out: 39
// tasks clone the same repository at once. They must run concurrently off the
// git backend, not queue behind a per-request jj export holding the repository
// write lock.
//
// Concurrency is asserted directly rather than with a wall-clock budget: every
// advertise-refs call waits at a barrier until a second one is in flight. If
// advertisements serialize, the first never sees a peer and fails.
func TestInfoRefsParallelClonesDoNotSerialize(t *testing.T) {
	const clones = 39
	f := newAdvertisementFixture(t, advertisementBenchCommits, advertisementBenchBookmarks, syntheticExportCost)
	f.advertise(t) // warm: one export syncs the git backend

	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Fatalf("look up git: %v", err)
	}
	barrier := t.TempDir()
	installGitStub(t, fmt.Sprintf(`#!/bin/sh
case " $* " in
*" --advertise-refs "*)
  : > %[1]q/$$
  tries=0
  while [ "$(ls %[1]q | wc -l)" -lt 2 ]; do
    tries=$((tries + 1))
    if [ "$tries" -gt 600 ]; then echo "advertisement never overlapped another" >&2; exit 1; fi
    sleep 0.05
  done
  ;;
esac
PATH=%[3]q exec %[2]q "$@"
`, barrier, realGit, os.Getenv("PATH")))

	var wg sync.WaitGroup
	for i := 0; i < clones; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			f.advertise(t)
		}()
	}
	wg.Wait()

	entries, err := os.ReadDir(barrier)
	if err != nil {
		t.Fatalf("read barrier: %v", err)
	}
	if len(entries) != clones {
		t.Fatalf("expected %d advertise-refs calls, got %d", clones, len(entries))
	}
	if got := f.exports.Load(); got != 1 {
		t.Fatalf("parallel advertisements re-exported refs: %d exports", got)
	}
}

// TestInfoRefsExportsAfterJJMutation pins the correctness half: skipping the
// export is only safe while the jj operation head is unchanged. A jj-side
// mutation must still be exported before the next advertisement.
func TestInfoRefsExportsAfterJJMutation(t *testing.T) {
	f := newAdvertisementFixture(t, 20, 5, 0)
	f.advertise(t)
	if got := f.exports.Load(); got != 1 {
		t.Fatalf("expected one export after the first advertisement, got %d", got)
	}
	f.advertise(t)
	if got := f.exports.Load(); got != 1 {
		t.Fatalf("expected the cached export to be reused, got %d", got)
	}

	writeOpHead(t, f.repoPath, strings.Repeat("b", 64))
	f.advertise(t)
	if got := f.exports.Load(); got != 2 {
		t.Fatalf("expected a re-export after the jj operation head moved, got %d", got)
	}
}

// TestImportRefsWarmsTheAdvertisementPath pins where the export cost is paid:
// a push imports refs while it already holds the repository write lock, so the
// clones that follow it must read the git backend only.
func TestImportRefsWarmsTheAdvertisementPath(t *testing.T) {
	f := newAdvertisementFixture(t, 20, 5, 0)

	writeOpHead(t, f.repoPath, strings.Repeat("c", 64))
	req := httptest.NewRequest(http.MethodPost, "/repos/alice/demo/git/import-refs", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("import-refs: expected 200, got %d; body=%s", w.Code, w.Body.String())
	}
	if got := f.exports.Load(); got != 1 {
		t.Fatalf("expected the import to export refs once, got %d", got)
	}

	f.advertise(t)
	f.advertise(t)
	if got := f.exports.Load(); got != 1 {
		t.Fatalf("advertisements after an import re-exported refs: %d exports", got)
	}
}

// TestInfoRefsExportsWhenOperationHeadIsUnreadable keeps the fallback honest:
// a repository whose op-head directory cannot be read must not silently skip
// the export.
func TestInfoRefsExportsWhenOperationHeadIsUnreadable(t *testing.T) {
	f := newAdvertisementFixture(t, 20, 5, 0)
	if err := os.RemoveAll(filepath.Join(f.repoPath, ".jj", "repo", "op_heads")); err != nil {
		t.Fatalf("remove op_heads: %v", err)
	}
	f.advertise(t)
	f.advertise(t)
	if got := f.exports.Load(); got != 2 {
		t.Fatalf("expected an export per request without a readable op head, got %d", got)
	}
}

// BenchmarkInfoRefsAdvertisement measures the steady-state advertisement of a
// ~1k commit, ~300 bookmark repository end to end through the router.
func BenchmarkInfoRefsAdvertisement(b *testing.B) {
	f := newAdvertisementFixture(b, advertisementBenchCommits, advertisementBenchBookmarks, syntheticExportCost)
	f.advertise(b)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		f.advertise(b)
	}
}
