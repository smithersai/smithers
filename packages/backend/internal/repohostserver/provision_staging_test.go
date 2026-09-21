package repohostserver

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

func provisionMock(t *testing.T, withGit bool) *mockFFI {
	t.Helper()
	return &mockFFI{initRepoFn: func(storePath string) (repohostffi.InitRepoResult, error) {
		if withGit {
			gitDir := filepath.Join(storePath, ".jj", "repo", "store", "git")
			if err := os.MkdirAll(filepath.Dir(gitDir), 0o755); err != nil {
				return repohostffi.InitRepoResult{}, err
			}
			if output, err := exec.Command("git", "init", "--bare", gitDir).CombinedOutput(); err != nil {
				return repohostffi.InitRepoResult{}, &testCommandError{err: err, output: string(output)}
			}
		} else if err := os.MkdirAll(storePath, 0o755); err != nil {
			return repohostffi.InitRepoResult{}, err
		}
		if err := os.WriteFile(filepath.Join(storePath, "identity"), []byte("token-owned"), 0o600); err != nil {
			return repohostffi.InitRepoResult{}, err
		}
		return repohostffi.InitRepoResult{Status: "ok", Path: storePath}, nil
	}}
}

type testCommandError struct {
	err    error
	output string
}

func (e *testCommandError) Error() string { return e.err.Error() + ": " + e.output }

func stageProvisionForTest(t *testing.T, srv *Server, request stageProvisionRequest, want int) *stageProvisionResponse {
	t.Helper()
	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/provision-stages", routerCovJSONBody(t, request))
	routerCovRequireStatus(t, rec, want)
	if want != http.StatusCreated {
		return nil
	}
	var response stageProvisionResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatalf("decode provision response: %v", err)
	}
	return &response
}

func TestProvisionStagePublishFinalizeLostResponsesAreIdempotent(t *testing.T) {
	srv := newTestServerWithMock(t, provisionMock(t, false))
	token := strings.Repeat("a1", deleteStageTokenBytes)
	request := stageProvisionRequest{
		Token: token, OperationType: provisionTypeInit, Owner: "alice", Repo: "demo", DefaultBookmark: "main",
	}

	for range 2 { // the second call models a lost Execute response
		response := stageProvisionForTest(t, srv, request, http.StatusCreated)
		if response.Token != token || response.Phase != provisionPhaseReady {
			t.Fatalf("stage response = %#v", response)
		}
	}
	stagedPath := filepath.Join(srv.provisionStageDir(token), provisionRepositoryDir)
	livePath := srv.config.RepoPath("alice", "demo")
	assertExists(t, stagedPath, true)
	assertExists(t, livePath, false)

	for range 2 { // the second call models a lost physical Publish response
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/provision-stages/"+token+"/publish", nil)
		routerCovRequireStatus(t, rec, http.StatusNoContent)
	}
	assertExists(t, stagedPath, false)
	assertExists(t, livePath, true)
	data, err := os.ReadFile(filepath.Join(livePath, "identity"))
	if err != nil || string(data) != "token-owned" {
		t.Fatalf("published identity = %q, err=%v", data, err)
	}

	for range 2 { // finalize is safe after a lost DB-completion response
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/provision-stages/"+token+"/finalize", nil)
		routerCovRequireStatus(t, rec, http.StatusNoContent)
	}
	assertExists(t, srv.provisionStageDir(token), false)
	assertExists(t, livePath, true)
}

func TestProvisionDestinationOccupiedIsCodedAndAbortNeverDeletesIt(t *testing.T) {
	srv := newTestServerWithMock(t, provisionMock(t, false))
	token := strings.Repeat("b2", deleteStageTokenBytes)
	livePath := srv.config.RepoPath("alice", "demo")
	mkdirAllT(t, livePath)
	marker := filepath.Join(livePath, "unrelated")
	if err := os.WriteFile(marker, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}

	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/provision-stages", routerCovJSONBody(t, stageProvisionRequest{
		Token: token, OperationType: provisionTypeInit, Owner: "alice", Repo: "demo", DefaultBookmark: "main",
	}))
	routerCovRequireStatus(t, rec, http.StatusConflict)
	var envelope errorEnvelope
	if err := json.NewDecoder(rec.Body).Decode(&envelope); err != nil {
		t.Fatalf("decode conflict: %v", err)
	}
	if envelope.Code != provisionConflictDestinationOccupied {
		t.Fatalf("conflict code = %q", envelope.Code)
	}

	rec = routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/provision-stages/"+token+"/abort", nil)
	routerCovRequireStatus(t, rec, http.StatusNoContent)
	data, err := os.ReadFile(marker)
	if err != nil || string(data) != "keep" {
		t.Fatalf("unrelated destination was modified: data=%q err=%v", data, err)
	}
}

func TestStagedImportGitRequiresDerivedCapabilityAndImportOperation(t *testing.T) {
	srv := newTestServerWithMock(t, provisionMock(t, true))
	token := strings.Repeat("c3", deleteStageTokenBytes)
	stageProvisionForTest(t, srv, stageProvisionRequest{
		Token: token, OperationType: provisionTypeImport, Owner: "alice", Repo: "mirror", DefaultBookmark: "main",
	}, http.StatusCreated)
	path := "/repos/provision-stages/" + token + "/git/info/refs?service=git-receive-pack"

	rec := routerCovServeWithHeaders(t, srv.Handler(), http.MethodGet, path, nil,
		map[string]string{"Authorization": "Bearer " + token})
	routerCovRequireStatus(t, rec, http.StatusUnauthorized)

	capability := repohost.StagedProvisionBearer(testAuthToken, token)
	rec = routerCovServeWithHeaders(t, srv.Handler(), http.MethodGet, path, nil,
		map[string]string{"Authorization": "Bearer " + capability})
	routerCovRequireStatus(t, rec, http.StatusOK)

	initToken := strings.Repeat("d4", deleteStageTokenBytes)
	stageProvisionForTest(t, srv, stageProvisionRequest{
		Token: initToken, OperationType: provisionTypeInit, Owner: "alice", Repo: "ordinary", DefaultBookmark: "main",
	}, http.StatusCreated)
	initPath := "/repos/provision-stages/" + initToken + "/git/info/refs?service=git-receive-pack"
	rec = routerCovServeWithHeaders(t, srv.Handler(), http.MethodGet, initPath, nil,
		map[string]string{"Authorization": "Bearer " + repohost.StagedProvisionBearer(testAuthToken, initToken)})
	routerCovRequireStatus(t, rec, http.StatusConflict)
}

func TestCreateBookmarkIfAbsentDoesNotMoveExistingBookmark(t *testing.T) {
	existing := repohost.Bookmark{Name: "work", TargetChangeID: "user-change"}
	srv := newTestServerWithMock(t, &mockFFI{
		createBookmarkIfAbsentFn: func(_ string, name, changeID string) (repohost.Bookmark, error) {
			if name != "work" || changeID != "import-head" {
				t.Fatalf("CreateBookmarkIfAbsent(%q, %q), want work/import-head", name, changeID)
			}
			return existing, nil
		},
	})
	mkdirAllT(t, srv.config.RepoPath("alice", "demo"))
	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice%3Ademo/bookmarks", routerCovJSONBody(t,
		repohost.CreateBookmarkRequest{Name: " work ", TargetChangeID: "import-head", IfAbsent: true}))
	routerCovRequireStatus(t, rec, http.StatusCreated)
	var got repohost.Bookmark
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode bookmark: %v", err)
	}
	if got != existing {
		t.Fatalf("bookmark = %+v, want existing %+v", got, existing)
	}
}
