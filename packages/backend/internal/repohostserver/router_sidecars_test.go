package repohostserver

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func mkdirAllT(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
}

func assertExists(t *testing.T, path string, want bool) {
	t.Helper()
	_, err := os.Stat(path)
	switch {
	case want && err != nil:
		t.Fatalf("expected %s to exist: %v", path, err)
	case !want && !os.IsNotExist(err):
		t.Fatalf("expected %s to be gone, stat err=%v", path, err)
	}
}

func TestDeleteRepo_RemovesWikiAndDocsSidecars(t *testing.T) {
	mock := &mockFFI{deleteRepoFn: func(storePath string) error { return os.RemoveAll(storePath) }}
	srv := newTestServerWithMock(t, mock)

	repoPath := srv.config.RepoPath("alice", "demo")
	wikiPath := srv.config.WikiRepoPath("alice", "demo")
	docsPath := srv.config.DocsRepoPath("alice", "demo")
	mkdirAllT(t, repoPath)
	mkdirAllT(t, wikiPath)
	mkdirAllT(t, docsPath)

	rec := routerCovServe(t, srv.Handler(), http.MethodDelete, "/repos/alice/demo", nil)
	routerCovRequireStatus(t, rec, http.StatusNoContent)

	assertExists(t, repoPath, false)
	assertExists(t, wikiPath, false)
	assertExists(t, docsPath, false)
	// Owner dir is pruned once the repo and its sidecars are gone.
	assertExists(t, filepath.Dir(repoPath), false)
}

func TestDeleteRepo_NoSidecarsStillSucceeds(t *testing.T) {
	mock := &mockFFI{deleteRepoFn: func(storePath string) error { return os.RemoveAll(storePath) }}
	srv := newTestServerWithMock(t, mock)
	mkdirAllT(t, srv.config.RepoPath("alice", "demo"))

	rec := routerCovServe(t, srv.Handler(), http.MethodDelete, "/repos/alice/demo", nil)
	routerCovRequireStatus(t, rec, http.StatusNoContent)
}

func TestMoveRepo_RelocatesWikiAndDocsSidecars(t *testing.T) {
	srv := newTestServer(t)

	mkdirAllT(t, srv.config.RepoPath("alice", "demo"))
	mkdirAllT(t, srv.config.WikiRepoPath("alice", "demo"))
	mkdirAllT(t, srv.config.DocsRepoPath("alice", "demo"))
	if err := os.WriteFile(filepath.Join(srv.config.WikiRepoPath("alice", "demo"), "Home.md"), []byte("wiki"), 0o644); err != nil {
		t.Fatalf("write wiki page: %v", err)
	}

	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move", routerCovJSONBody(t, moveRepoRequest{
		SrcOwner: "alice", SrcRepo: "demo", DstOwner: "beta", DstRepo: "demo",
	}))
	routerCovRequireStatus(t, rec, http.StatusOK)

	assertExists(t, srv.config.RepoPath("beta", "demo"), true)
	assertExists(t, srv.config.WikiRepoPath("beta", "demo"), true)
	assertExists(t, srv.config.DocsRepoPath("beta", "demo"), true)
	assertExists(t, filepath.Join(srv.config.WikiRepoPath("beta", "demo"), "Home.md"), true)
	assertExists(t, srv.config.RepoPath("alice", "demo"), false)
	assertExists(t, srv.config.WikiRepoPath("alice", "demo"), false)
	assertExists(t, srv.config.DocsRepoPath("alice", "demo"), false)
}

func TestMoveRepo_NoSidecarsMovesRepoOnly(t *testing.T) {
	srv := newTestServer(t)
	mkdirAllT(t, srv.config.RepoPath("alice", "demo"))

	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move", routerCovJSONBody(t, moveRepoRequest{
		SrcOwner: "alice", SrcRepo: "demo", DstOwner: "beta", DstRepo: "demo",
	}))
	routerCovRequireStatus(t, rec, http.StatusOK)

	assertExists(t, srv.config.RepoPath("beta", "demo"), true)
	assertExists(t, srv.config.WikiRepoPath("beta", "demo"), false)
	assertExists(t, srv.config.RepoPath("alice", "demo"), false)
}

func TestMoveRepo_DestinationSidecarCollisionRejected(t *testing.T) {
	srv := newTestServer(t)
	mkdirAllT(t, srv.config.RepoPath("alice", "demo"))
	mkdirAllT(t, srv.config.WikiRepoPath("alice", "demo"))
	// A leftover wiki store under the destination owner (e.g. orphaned by an
	// earlier delete) must not be silently overwritten or merged.
	mkdirAllT(t, srv.config.WikiRepoPath("beta", "demo"))

	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move", routerCovJSONBody(t, moveRepoRequest{
		SrcOwner: "alice", SrcRepo: "demo", DstOwner: "beta", DstRepo: "demo",
	}))
	routerCovRequireStatus(t, rec, http.StatusBadRequest)

	// Nothing moved.
	assertExists(t, srv.config.RepoPath("alice", "demo"), true)
	assertExists(t, srv.config.WikiRepoPath("alice", "demo"), true)
}
