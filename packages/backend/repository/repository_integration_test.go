package repository

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

// Run with SMITHERS_FFI_LIBRARY_PATH pointing at the built smithers-ffi dylib.
// Both modes use the same real repository engine, Git transport, and jj store.
func TestRepositoryLifecycle(t *testing.T) {
	ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if ffi == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to run the repository integration suite")
	}
	if _, err := os.Stat(ffi); err != nil {
		t.Fatal(err)
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"local", "service"} {
		t.Run(mode, func(t *testing.T) {
			cfg := Config{StoragePath: t.TempDir(), AuthToken: "test-repo-token", FFILibraryPath: ffi}
			var handler http.Handler
			var client *Client
			if mode == "local" {
				local, err := OpenLocal(cfg)
				if err != nil {
					t.Fatal(err)
				}
				defer local.Shutdown(context.Background())
				handler, client = local.Handler(), local.Client()
				for _, path := range []string{"/health", "/metrics", "/repos/init", "/repos/provision-stages/token/publish"} {
					response := httptest.NewRecorder()
					handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
					if response.Code != http.StatusNotFound {
						t.Fatalf("local handler exposed %s: %d", path, response.Code)
					}
				}
			} else {
				service, err := NewService(cfg)
				if err != nil {
					t.Fatal(err)
				}
				defer service.Shutdown(context.Background())
				handler = service.Handler()
			}
			host := httptest.NewServer(handler)
			defer host.Close()
			if client == nil {
				client = NewRemoteClient(&repohost.StaticStorageSetResolver{URL: host.URL}, cfg.AuthToken)
			}
			ctx := context.Background()
			if err := client.InitRepo(ctx, "alice", "demo", "main", true); err != nil {
				t.Fatal(err)
			}
			mainHead := bookmark(t, client, "main")
			remote := host.URL + "/git/alice/demo.git"
			work := filepath.Join(t.TempDir(), "clone")
			git(t, "", cfg.AuthToken, "clone", remote, work)
			git(t, work, "", "checkout", "-b", "feature")
			if err := os.WriteFile(filepath.Join(work, "note.txt"), []byte("land me\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			git(t, work, "", "add", "note.txt")
			git(t, work, "", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Add note")
			sha := strings.TrimSpace(git(t, work, "", "rev-parse", "HEAD"))
			git(t, work, cfg.AuthToken, "push", "origin", "feature")
			changes, _, err := client.ListChanges(ctx, "alice", "demo", "", 100)
			if err != nil {
				t.Fatal(err)
			}
			var changeID string
			for _, change := range changes {
				if change.CommitID == sha {
					changeID = change.ChangeID
					break
				}
			}
			if changeID == "" {
				t.Fatalf("pushed commit %s missing from jj changes: %+v", sha, changes)
			}
			diff, err := client.GetChangeDiff(ctx, "alice", "demo", changeID)
			if err != nil {
				t.Fatal(err)
			}
			if len(diff.FileDiffs) == 0 {
				t.Fatal("jj diff omitted pushed file")
			}
			land := repohost.LandRequest{ChangeIDs: []string{changeID}, TargetBookmark: "main", ExpectedCommitID: &mainHead.TargetCommitID, OperationKey: "integration-land"}
			result, err := client.LandChanges(ctx, "alice", "demo", land)
			if err != nil {
				t.Fatal(err)
			}
			if result.TargetCommitID == mainHead.TargetCommitID {
				t.Fatal("landing did not move main")
			}
			replayed, err := client.LandChanges(ctx, "alice", "demo", land)
			if err != nil || replayed.TargetCommitID != result.TargetCommitID {
				t.Fatalf("landing replay: %+v, %v", replayed, err)
			}
			land.OperationKey = "stale-second-land"
			if _, err := client.LandChanges(ctx, "alice", "demo", land); err == nil {
				t.Fatal("stale landing unexpectedly succeeded")
			}
			fresh := filepath.Join(t.TempDir(), "fresh")
			git(t, "", cfg.AuthToken, "clone", remote, fresh)
			content, err := os.ReadFile(filepath.Join(fresh, "note.txt"))
			if err != nil || string(content) != "land me\n" {
				t.Fatalf("fresh clone: %q, %v", content, err)
			}
			// Model a crash after jj wrote the bookmark but before it restored
			// Git HEAD. A retry must repair HEAD without repeating the landing.
			repoPath := filepath.Join(cfg.StoragePath, "alice", "demo")
			headPath := filepath.Join(repoPath, ".jj", "repo", "store", "git", "HEAD")
			if err := os.WriteFile(headPath, []byte(mainHead.TargetCommitID+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			bridge := repohostffi.New(ffi)
			if err := bridge.Load(); err != nil {
				t.Fatal(err)
			}
			if err := bridge.ExportGitRefs(repoPath); err != nil {
				t.Fatal(err)
			}
			head, err := os.ReadFile(headPath)
			if err != nil || string(head) != "ref: refs/heads/main\n" {
				t.Fatalf("default Git HEAD was not reconciled: %q, %v", head, err)
			}
			// The public Git route has the same bearer check as the API routes.
			req, _ := http.NewRequest(http.MethodGet, remote+"/info/refs?service=git-upload-pack", nil)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("unauthorized Git read: %d", resp.StatusCode)
			}
			req, _ = http.NewRequest(http.MethodPost, remote+"/git-receive-pack", strings.NewReader(""))
			resp, err = http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("unauthorized Git push: %d", resp.StatusCode)
			}
			req, _ = http.NewRequest(http.MethodGet, host.URL+"/git/alice/other.git/info/refs?service=git-upload-pack", nil)
			req.Header.Set("Authorization", "Bearer "+cfg.AuthToken)
			resp, err = http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusNotFound {
				t.Fatalf("cross-repository read: %d", resp.StatusCode)
			}
			if err := client.InitRepo(ctx, "..", "escape", "main", false); err == nil {
				t.Fatal("path traversal accepted")
			}
			req, _ = http.NewRequest(http.MethodPost, host.URL+"/repos/init", strings.NewReader(strings.Repeat("x", 1<<20+1)))
			req.Header.Set("Authorization", "Bearer "+cfg.AuthToken)
			resp, err = http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if mode == "local" && resp.StatusCode != http.StatusNotFound ||
				mode == "service" && resp.StatusCode != http.StatusBadRequest && resp.StatusCode != http.StatusRequestEntityTooLarge {
				t.Fatalf("oversized JSON: %d", resp.StatusCode)
			}
		})
	}
}

func TestLocalStagedProvisionUsesEmbeddedRepository(t *testing.T) {
	ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if ffi == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to run the repository integration suite")
	}
	local, err := OpenLocal(Config{StoragePath: t.TempDir(), AuthToken: "stage-token", FFILibraryPath: ffi})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = local.Shutdown(context.Background()) })
	// A product API handler carries an outer chi route context into the
	// in-process repository client. Exercise the real nested router call.
	var provisionErr error
	outer := chi.NewRouter()
	outer.Route("/api", func(routes chi.Router) {
		routes.Post("/user/repos", func(_ http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			staged, err := local.Client().PrepareStagedInit(ctx, "s1", "owner", "repo", "main", true)
			if err == nil {
				err = local.Client().ExecuteStagedProvision(ctx, staged)
			}
			if err == nil {
				err = local.Client().PublishStagedProvision(ctx, staged)
			}
			if err == nil {
				err = local.Client().FinalizeStagedProvision(ctx, staged)
			}
			provisionErr = err
		})
	})
	outer.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/user/repos", nil))
	if provisionErr != nil {
		t.Fatal(provisionErr)
	}
}

func TestLocalStagedGitImportUsesReachableLoopback(t *testing.T) {
	ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if ffi == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to run the repository integration suite")
	}
	local, err := OpenLocal(Config{StoragePath: t.TempDir(), AuthToken: "test-repo-token", FFILibraryPath: ffi})
	if err != nil {
		t.Fatal(err)
	}
	defer local.Shutdown(context.Background())
	ctx := context.Background()
	staged, err := local.Client().PrepareStagedImport(ctx, "local", "alice", "imported", "main")
	if err != nil {
		t.Fatal(err)
	}
	if err := local.Client().ExecuteStagedProvision(ctx, staged); err != nil {
		t.Fatal(err)
	}
	endpoint, bearer, err := local.Client().StagedProvisionGitEndpoint(ctx, staged)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(endpoint, "http://127.0.0.1:") {
		t.Fatalf("staging endpoint = %q", endpoint)
	}
	work := t.TempDir()
	git(t, work, "", "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(work, "README.md"), []byte("imported\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, work, "", "add", ".")
	git(t, work, "", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Import")
	git(t, work, bearer, "push", endpoint, "main")
	if err := local.Client().PublishStagedProvision(ctx, staged); err != nil {
		t.Fatal(err)
	}
	if err := local.Client().FinalizeStagedProvision(ctx, staged); err != nil {
		t.Fatal(err)
	}
	bookmarks, _, err := local.Client().ListBookmarks(ctx, "alice", "imported", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, bookmark := range bookmarks {
		if bookmark.Name == "main" {
			found = true
		}
	}
	if !found {
		t.Fatalf("main bookmark missing after import: %+v", bookmarks)
	}
}

func bookmark(t *testing.T, client *Client, name string) repohost.Bookmark {
	t.Helper()
	bookmarks, _, err := client.ListBookmarks(context.Background(), "alice", "demo", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, bookmark := range bookmarks {
		if bookmark.Name == name {
			return bookmark
		}
	}
	t.Fatalf("bookmark %q missing: %+v", name, bookmarks)
	return repohost.Bookmark{}
}

func git(t *testing.T, dir, token string, args ...string) string {
	t.Helper()
	if token != "" {
		args = append([]string{"-c", "http.extraHeader=Authorization: Bearer " + token}, args...)
	}
	cmd := exec.Command("git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return string(out)
}
