package routes

import (
	"bytes"
	"compress/zlib"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type notesIntegrationQueries struct {
	services.RepoQuerier
	repository db.Repository
}

func (q *notesIntegrationQueries) GetRepoByOwnerAndLowerName(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	return q.repository, nil
}

// The only substituted boundary is database lookup. Both HTTP hops and the
// Rust/jj object-store read are real. Run with SMITHERS_FFI_LIBRARY_PATH set.
func TestNotesMirrorIntegration(t *testing.T) {
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if library == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to the built smithers-ffi library")
	}
	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "notes-test", FFILibraryPath: library}
	ffi := repohostffi.New(library)
	require.NoError(t, ffi.Load())
	_, err := ffi.InitRepo(cfg.RepoPath("alice", "demo"))
	require.NoError(t, err)
	backend, err := repohostserver.NewWithFFI(cfg, ffi)
	require.NoError(t, err)
	host := httptest.NewServer(backend.Handler())
	defer host.Close()
	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: host.URL}, cfg.AuthToken)
	q := &notesIntegrationQueries{repository: db.Repository{ID: 1, Name: "demo", IsPublic: true, DefaultBookmark: "main"}}
	handler := RepoHandler{Service: services.NewRepoService(q, client, "s1")}
	router := chi.NewRouter()
	router.With(middleware.RequireTokenScope(middleware.ScopeReadRepository)).Get("/api/repos/{owner}/{repo}/git/refs", handler.ListGitRefs)
	router.With(middleware.RequireTokenScope(middleware.ScopeReadRepository)).Get("/api/repos/{owner}/{repo}/contents/*", handler.GetRepoContents)
	request := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}
	empty := request("/api/repos/alice/demo/git/refs")
	require.Equal(t, 200, empty.Code, empty.Body.String())
	require.JSONEq(t, "[]", empty.Body.String())
	// Write a real notes-only commit as loose Git objects, without invoking a
	// Git command or manufacturing a jj bookmark/index entry.
	gitDir := cfg.GitBackendPath("alice", "demo")
	blob := writeNotesObject(t, gitDir, "blob", []byte("story"))
	subtree := writeNotesObject(t, gitDir, "tree", append([]byte("100644 cd\x00"), blob...))
	tree := writeNotesObject(t, gitDir, "tree", append([]byte("40000 ab\x00"), subtree...))
	commit := writeNotesObject(t, gitDir, "commit", []byte(fmt.Sprintf("tree %x\nauthor Librarian <librarian@example.com> 1711398853 +0000\ncommitter Librarian <librarian@example.com> 1711398853 +0000\n\nnotes\n", tree)))
	sha := hex.EncodeToString(commit)
	require.NoError(t, os.MkdirAll(filepath.Join(gitDir, "refs", "notes"), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(gitDir, "refs", "notes", "mythical"), []byte(sha+"\n"), 0644))
	require.NoError(t, ffi.ImportGitRefs(cfg.RepoPath("alice", "demo")))
	bookmarks, err := ffi.ListBookmarks(cfg.RepoPath("alice", "demo"), 1, 100)
	require.NoError(t, err)
	require.Empty(t, bookmarks.Items)
	refs := request("/api/repos/alice/demo/git/refs")
	require.Equal(t, 200, refs.Code, refs.Body.String())
	var result []services.GitRef
	require.NoError(t, json.Unmarshal(refs.Body.Bytes(), &result))
	require.Equal(t, []services.GitRef{{Ref: "refs/notes/mythical", Object: services.GitRefObject{SHA: sha, Type: "commit"}}}, result)
	content := request("/api/repos/alice/demo/contents/ab/cd?ref=" + result[0].Object.SHA)
	require.Equal(t, 200, content.Code, content.Body.String())
	require.JSONEq(t, `{"name":"cd","path":"ab/cd","sha":"","type":"file","encoding":"utf-8","content":"story","size":5}`, content.Body.String())
	q.repository.IsPublic = false
	deniedRefs := request("/api/repos/alice/demo/git/refs")
	deniedContent := request("/api/repos/alice/demo/contents/ab/cd?ref=" + sha)
	require.Equal(t, 403, deniedRefs.Code)
	require.Equal(t, 403, deniedContent.Code)
	require.JSONEq(t, deniedRefs.Body.String(), deniedContent.Body.String())
}

func writeNotesObject(t *testing.T, gitDir, kind string, body []byte) []byte {
	t.Helper()
	raw := append([]byte(fmt.Sprintf("%s %d\x00", kind, len(body))), body...)
	sum := sha1.Sum(raw)
	name := hex.EncodeToString(sum[:])
	var compressed bytes.Buffer
	writer := zlib.NewWriter(&compressed)
	_, err := writer.Write(raw)
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	dir := filepath.Join(gitDir, "objects", name[:2])
	require.NoError(t, os.MkdirAll(dir, 0755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, name[2:]), compressed.Bytes(), 0444))
	return sum[:]
}
