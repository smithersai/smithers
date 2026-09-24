package smitherscli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func commandsStackHSetAPIConfig(t *testing.T, apiURL string) {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	t.Setenv("SMITHERS_TOKEN", "commands_stack_h_token")
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commandsStackHServe(t *testing.T, argv ...string) string {
	t.Helper()
	var stdout bytes.Buffer
	if err := stackCommand().ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("stack %v returned error: %v\n%s", argv, err, stdout.String())
	}
	return stdout.String()
}

func commandsStackHServeWantErr(t *testing.T, want string, argv ...string) {
	t.Helper()
	var stdout bytes.Buffer
	err := stackCommand().ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout})
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("stack %v error = %v, want contains %q\n%s", argv, err, want, stdout.String())
	}
}

func commandsStackHInstallFakeJj(t *testing.T) {
	t.Helper()
	binDir := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
args="$*"
case "$args" in
  "--version") printf 'jj 0.99.0\n'; exit 0 ;;
esac
if printf '%s' "$args" | grep -q 'git fetch'; then
  if [ "${COMMANDS_STACK_H_FAIL:-}" = "fetch" ]; then
    printf 'fetch failed\n' >&2
    exit 2
  fi
  exit 0
fi
if printf '%s' "$args" | grep -q 'author.name'; then
  printf 'Stack Author\tauthor@example.com\n'
  exit 0
fi
if printf '%s' "$args" | grep -q 'rebase'; then
  if [ "${COMMANDS_STACK_H_FAIL:-}" = "rebase" ]; then
    printf 'rebase failed\n' >&2
    exit 3
  fi
  exit 0
fi
if printf '%s' "$args" | grep -q 'bookmark set'; then
  if [ "${COMMANDS_STACK_H_FAIL:-}" = "set" ]; then
    printf 'set failed\n' >&2
    exit 4
  fi
  exit 0
fi
if printf '%s' "$args" | grep -q 'git push'; then
  case "${COMMANDS_STACK_H_FAIL:-}" in
    push-diverged) printf 'remote bookmark unexpectedly moved; run jj git fetch\n' >&2; exit 5 ;;
    push-other) printf 'permission denied\n' >&2; exit 6 ;;
  esac
  exit 0
fi
if printf '%s' "$args" | grep -q 'commit_id' && printf '%s' "$args" | grep -q '::@'; then
  if [ "${COMMANDS_STACK_H_LOCAL:-}" = "one" ]; then
    printf 'bbb22222\tcommit-b\n'
  else
    printf 'aaa11111\tcommit-a\nbbb22222\tcommit-b\n'
  fi
  exit 0
fi
if printf '%s' "$args" | grep -q 'description'; then
  if printf '%s' "$args" | grep -q 'aaa11111'; then
    printf 'First change\n\nFirst body\n'
  elif printf '%s' "$args" | grep -q 'bbb22222'; then
    printf 'Second change\n\nSecond body\n'
  else
    printf 'Mapped change\n\nMapped body\n'
  fi
  exit 0
fi
exit 0
`
	if err := os.WriteFile(filepath.Join(binDir, "jj"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestCommandsStack_H_CommandWorkflows(t *testing.T) {
	commandsStackHInstallFakeJj(t)
	t.Setenv("GITHUB_TOKEN", "github-h-token")
	t.Setenv("COMMANDS_STACK_H_LOCAL", "")

	backendCalls := []string{}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backendCalls = append(backendCalls, r.Method+" "+r.URL.RequestURI())
		if got := r.Header.Get("Authorization"); got != "token commands_stack_h_token" {
			t.Errorf("backend auth = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/stacks/active" && r.URL.Query().Get("target_ref") == "submit":
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"none"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/stacks/active":
			fmt.Fprint(w, `{"id":42,"state":"active","target_ref":"main","changes":[{"change_id":"aaa11111","branch_name":"smithers/aaa11111","position":0,"pr_number":1,"pr_state":"open","ci_status":"passing","review_status":"approved"},{"change_id":"bbb22222","branch_name":"smithers/bbb22222","position":1,"pr_number":2,"pr_state":"open","ci_status":"passing","review_status":"approved"}]}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/stacks/active":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("persist body decode: %v", err)
			}
			if len(arrayValue(body["changes"])) == 0 {
				t.Errorf("persisted empty stack body: %#v", body)
			}
			fmt.Fprint(w, `{"id":99}`)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/repos/alice/demo/stacks/active":
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing backend"}`)
		}
	}))
	defer backend.Close()
	commandsStackHSetAPIConfig(t, backend.URL)

	nextPR := 10
	landPhase := false
	mergeAttempts := map[string]int{}
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer github-h-token" {
			t.Errorf("github auth = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/repos/alice/demo/pulls":
			nextPR++
			fmt.Fprintf(w, `{"number":%d,"state":"open","html_url":"https://github.local/pr/%d"}`, nextPR, nextPR)
		case r.Method == http.MethodPatch && strings.HasPrefix(r.URL.Path, "/repos/alice/demo/pulls/"):
			fmt.Fprint(w, `{"state":"open","html_url":"https://github.local/updated"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/repos/alice/demo/pulls/1":
			if landPhase {
				fmt.Fprint(w, `{"state":"open","merged":false,"mergeable":true,"html_url":"https://github.local/pr/1","head":{"sha":"sha-1"}}`)
				return
			}
			fmt.Fprint(w, `{"state":"closed","merged":true,"html_url":"https://github.local/pr/1","head":{"sha":"sha-1"}}`)
		case r.Method == http.MethodGet && r.URL.Path == "/repos/alice/demo/pulls/2":
			fmt.Fprint(w, `{"state":"open","merged":false,"mergeable":true,"html_url":"https://github.local/pr/2","head":{"sha":"sha-2"}}`)
		case r.Method == http.MethodGet && r.URL.Path == "/repos/alice/demo/commits/sha-1/check-runs":
			fmt.Fprint(w, `{"check_runs":[{"name":"unit","status":"completed","conclusion":"success"}]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/repos/alice/demo/commits/sha-2/check-runs":
			fmt.Fprint(w, `{"check_runs":[{"name":"unit","status":"completed","conclusion":"success"}]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/repos/alice/demo/pulls/1/reviews":
			fmt.Fprint(w, `[{"user":{"login":"reviewer"},"state":"APPROVED"}]`)
		case r.Method == http.MethodGet && r.URL.Path == "/repos/alice/demo/pulls/2/reviews":
			fmt.Fprint(w, `[{"user":{"login":"reviewer"},"state":"APPROVED"}]`)
		case r.Method == http.MethodPut && r.URL.Path == "/repos/alice/demo/pulls/1/merge":
			mergeAttempts[r.URL.Path]++
			fmt.Fprint(w, `{"merged":true}`)
		case r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/git/refs/heads/"):
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprintf(w, `{"message":"missing github %s %s"}`, r.Method, r.URL.Path)
		}
	}))
	defer github.Close()
	t.Setenv("SMITHERS_GITHUB_API_URL", github.URL)

	commandsStackHServe(t, "submit", "--repo", "alice/demo", "--target", "submit", "--json")
	commandsStackHServe(t, "status", "--repo", "alice/demo", "--target", "main", "--json")
	t.Setenv("COMMANDS_STACK_H_LOCAL", "one")
	commandsStackHServe(t, "sync", "--repo", "alice/demo", "--target", "main", "--json")
	t.Setenv("COMMANDS_STACK_H_LOCAL", "")
	landPhase = true
	commandsStackHServe(t, "land", "--change", "aaa", "--repo", "alice/demo", "--target", "main", "--json")
	commandsStackHServe(t, "unsubmit", "--repo", "alice/demo", "--target", "main", "--json")
	commandsStackHServeWantErr(t, "Specify only one", "land", "--all", "--change", "aaa", "--repo", "alice/demo")
	commandsStackHServeWantErr(t, "`--change` requires", "land", "--change", "", "--repo", "alice/demo")
	if len(backendCalls) < 8 || mergeAttempts["/repos/alice/demo/pulls/1/merge"] == 0 {
		t.Fatalf("expected stack workflow backend/merge calls, backend=%v merge=%v", backendCalls, mergeAttempts)
	}
}

func TestCommandsStack_H_HTTPProxyAndAPIErrors(t *testing.T) {
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/nocontent":
			w.WriteHeader(http.StatusNoContent)
		case "/empty":
		case "/bad-json":
			fmt.Fprint(w, `{`)
		case "/error-text":
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprint(w, `plain github failure`)
		default:
			fmt.Fprint(w, `{"ok":true}`)
		}
	}))
	defer github.Close()
	t.Setenv("GITHUB_TOKEN", "token")
	t.Setenv("SMITHERS_GITHUB_API_URL", github.URL)
	if got, err := githubAPI(http.MethodGet, "/nocontent", nil); err != nil || got != nil {
		t.Fatalf("githubAPI no content = (%#v, %v)", got, err)
	}
	if got, err := githubAPI(http.MethodGet, "/empty", nil); err != nil || got != nil {
		t.Fatalf("githubAPI empty body = (%#v, %v)", got, err)
	}
	if _, err := githubAPI(http.MethodGet, "/bad-json", nil); err == nil {
		t.Fatal("githubAPI accepted invalid JSON")
	}
	if _, err := githubAPI(http.MethodGet, "/error-text", nil); err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("githubAPI text error = %v", err)
	}
	if _, err := githubAPI(http.MethodPost, "/ok", map[string]any{"bad": func() {}}); err == nil {
		t.Fatal("githubAPI accepted unmarshalable request body")
	}
	t.Setenv("SMITHERS_GITHUB_API_URL", "://bad-url")
	if _, err := githubAPI(http.MethodGet, "/ok", nil); err == nil {
		t.Fatal("githubAPI accepted invalid base URL")
	}

	var proxyMode string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch proxyMode {
		case "nil":
			w.WriteHeader(http.StatusNoContent)
		case "unsupported":
			fmt.Fprint(w, `"plain"`)
		case "error":
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprint(w, `{"message":"proxy denied"}`)
		default:
			fmt.Fprint(w, `{"proxied":true}`)
		}
	}))
	defer backend.Close()
	commandsStackHSetAPIConfig(t, backend.URL)
	t.Setenv("GITHUB_TOKEN", "")
	proxyMode = ""
	proxied, err := githubAPIViaSmithersProxy(http.MethodGet, "/repos/alice/demo/pulls/1", nil)
	if err != nil || proxied["proxied"] != true {
		t.Fatalf("proxy object response = (%#v, %v)", proxied, err)
	}
	proxyMode = "nil"
	if proxied, err = githubAPIViaSmithersProxy(http.MethodGet, "/repos/alice/demo/pulls/1", nil); err != nil || proxied != nil {
		t.Fatalf("proxy nil response = (%#v, %v)", proxied, err)
	}
	proxyMode = "unsupported"
	if _, err = githubAPIViaSmithersProxy(http.MethodGet, "/repos/alice/demo/pulls/1", nil); err == nil || !strings.Contains(err.Error(), "unsupported") {
		t.Fatalf("proxy unsupported response = %v", err)
	}
	proxyMode = "error"
	if _, err = githubAPIViaSmithersProxy(http.MethodGet, "/repos/alice/demo/pulls/1", nil); err == nil || !strings.Contains(err.Error(), "proxy denied") {
		t.Fatalf("proxy API error = %v", err)
	}
	if _, err = loadExistingStack("alice", "demo", "main"); err == nil || !strings.Contains(err.Error(), "proxy denied") {
		t.Fatalf("loadExistingStack non-404 = %v", err)
	}
	if err = deleteActiveStackMapping("alice", "demo", "main"); err == nil || !strings.Contains(err.Error(), "proxy denied") {
		t.Fatalf("deleteActiveStackMapping non-404 = %v", err)
	}
}

func TestCommandsStack_H_PRMutationAndSelectionBranches(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "token")
	patchAttempts := map[string]int{}
	mergeAttempts := map[string]int{}
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		key := r.Method + " " + r.URL.Path
		switch key {
		case "GET /repos/alice/demo/pulls/10":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"get failed"}`)
		case "GET /repos/alice/demo/pulls/11", "GET /repos/alice/demo/pulls/12", "GET /repos/alice/demo/pulls/13", "GET /repos/alice/demo/pulls/14", "GET /repos/alice/demo/pulls/15":
			if patchAttempts[r.URL.Path] > 0 {
				switch r.URL.Path {
				case "/repos/alice/demo/pulls/12":
					fmt.Fprint(w, `{"state":"closed"}`)
				case "/repos/alice/demo/pulls/13":
					w.WriteHeader(http.StatusNotFound)
					fmt.Fprint(w, `{"message":"gone"}`)
				case "/repos/alice/demo/pulls/14":
					w.WriteHeader(http.StatusInternalServerError)
					fmt.Fprint(w, `{"message":"refresh failed"}`)
				default:
					fmt.Fprint(w, `{"state":"open"}`)
				}
				return
			}
			fmt.Fprint(w, `{"state":"open"}`)
		case "PATCH /repos/alice/demo/pulls/11":
			patchAttempts["/repos/alice/demo/pulls/11"]++
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"gone"}`)
		case "PATCH /repos/alice/demo/pulls/12", "PATCH /repos/alice/demo/pulls/13", "PATCH /repos/alice/demo/pulls/14":
			patchAttempts[strings.TrimPrefix(key, "PATCH ")]++
			w.WriteHeader(http.StatusUnprocessableEntity)
			fmt.Fprint(w, `{"message":"already closed maybe"}`)
		case "PATCH /repos/alice/demo/pulls/15":
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprint(w, `{"message":"cannot close"}`)
		case "DELETE /repos/alice/demo/git/refs/heads/protected":
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprint(w, `{"message":"protected"}`)
		case "PUT /repos/alice/demo/pulls/20/merge":
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		case "PUT /repos/alice/demo/pulls/21/merge":
			fmt.Fprint(w, `{"merged":false}`)
		case "PUT /repos/alice/demo/pulls/22/merge":
			mergeAttempts[r.URL.Path]++
			w.WriteHeader(http.StatusMethodNotAllowed)
			fmt.Fprint(w, `{"message":"method disabled"}`)
		case "PUT /repos/alice/demo/pulls/23/merge":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"github down"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprintf(w, `{"message":"unexpected %s"}`, key)
		}
	}))
	defer github.Close()
	t.Setenv("SMITHERS_GITHUB_API_URL", github.URL)

	if _, err := closePullRequestIfOpen("alice", "demo", 10); err == nil || !strings.Contains(err.Error(), "get failed") {
		t.Fatalf("closePullRequestIfOpen get error = %v", err)
	}
	if status, err := closePullRequestIfOpen("alice", "demo", 11); err != nil || status != "missing" {
		t.Fatalf("closePullRequestIfOpen patch 404 = %q, %v", status, err)
	}
	if status, err := closePullRequestIfOpen("alice", "demo", 12); err != nil || status != "already_closed" {
		t.Fatalf("closePullRequestIfOpen patch 422 closed = %q, %v", status, err)
	}
	if status, err := closePullRequestIfOpen("alice", "demo", 13); err != nil || status != "missing" {
		t.Fatalf("closePullRequestIfOpen refresh missing = %q, %v", status, err)
	}
	if _, err := closePullRequestIfOpen("alice", "demo", 14); err == nil || !strings.Contains(err.Error(), "already closed maybe") {
		t.Fatalf("closePullRequestIfOpen refresh error = %v", err)
	}
	if _, err := closePullRequestIfOpen("alice", "demo", 15); err == nil || !strings.Contains(err.Error(), "cannot close") {
		t.Fatalf("closePullRequestIfOpen patch error = %v", err)
	}
	if _, err := deleteRemoteBranchIfExists("alice", "demo", "protected"); err == nil || !strings.Contains(err.Error(), "protected") {
		t.Fatalf("deleteRemoteBranchIfExists protected = %v", err)
	}
	if err := mergePullRequest("alice", "demo", 20); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("mergePullRequest missing = %v", err)
	}
	if err := mergePullRequest("alice", "demo", 21); err == nil || !strings.Contains(err.Error(), "did not merge") {
		t.Fatalf("mergePullRequest merged false = %v", err)
	}
	if err := mergePullRequest("alice", "demo", 22); err == nil || !strings.Contains(err.Error(), "rejected available merge methods") {
		t.Fatalf("mergePullRequest methods rejected = %v", err)
	}
	if mergeAttempts["/repos/alice/demo/pulls/22/merge"] != 3 {
		t.Fatalf("merge methods attempts = %v", mergeAttempts)
	}
	if err := mergePullRequest("alice", "demo", 23); err == nil || !strings.Contains(err.Error(), "github down") {
		t.Fatalf("mergePullRequest generic error = %v", err)
	}

	changes := []stackLandChange{
		{ChangeID: "aaa111", PRNumber: 1, ReviewStatus: "approved", CIStatus: "passing", PRState: "open"},
		{ChangeID: "bbb222", PRNumber: 2, ReviewStatus: "pending", CIStatus: "passing", PRState: "open"},
	}
	if _, err := selectStackLandCount(changes, false, "bbb", true); err == nil || !strings.Contains(err.Error(), "pending review") {
		t.Fatalf("selectStackLandCount requested unlandable = %v", err)
	}
	if count, err := selectStackLandCount(changes, true, "", false); err != nil || count != 1 {
		t.Fatalf("selectStackLandCount all partial = %d, %v", count, err)
	}
	if reason := stackLandabilityError(stackLandChange{ChangeID: "ccc333", PRNumber: 3, ReviewStatus: "approved", CIStatus: "passing"}); !strings.Contains(reason, "unknown") {
		t.Fatalf("stackLandabilityError unknown state = %q", reason)
	}
}

func TestCommandsStack_H_RestackStatusAndFormattingBranches(t *testing.T) {
	commandsStackHInstallFakeJj(t)
	t.Setenv("GITHUB_TOKEN", "token")
	t.Setenv("COMMANDS_STACK_H_LOCAL", "one")

	var persistMode string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if persistMode == "error" && r.Method == http.MethodPost {
			w.WriteHeader(http.StatusConflict)
			fmt.Fprint(w, `{"message":"persist failed"}`)
			return
		}
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		fmt.Fprint(w, `{"id":123}`)
	}))
	defer backend.Close()
	commandsStackHSetAPIConfig(t, backend.URL)

	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPatch && strings.Contains(r.URL.Path, "/pulls/2"):
			fmt.Fprint(w, `{"state":"open","html_url":"https://github.local/pr/2"}`)
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/pulls/2"):
			fmt.Fprint(w, `{"state":"open","html_url":"https://github.local/pr/2","head":{"sha":"sha-2"}}`)
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/check-runs"):
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"checks unavailable"}`)
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/reviews"):
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"reviews unavailable"}`)
		default:
			fmt.Fprint(w, `{"state":"open"}`)
		}
	}))
	defer github.Close()
	t.Setenv("SMITHERS_GITHUB_API_URL", github.URL)

	remaining := []stackLandChange{{Branch: "smithers/bbb22222", ChangeID: "bbb22222", PRNumber: 2, PRState: "open", PRURL: "old", CIStatus: "passing", ReviewStatus: "approved"}}
	result, err := restackRemainingAfterLanding("alice", "demo", "main", remaining)
	if err != nil || result["stack_deleted"] == true || intValue(result["stack_id"], 0) != 123 {
		t.Fatalf("restackRemainingAfterLanding success = (%#v, %v)", result, err)
	}
	emptyResult, err := restackRemainingAfterLanding("alice", "demo", "main", nil)
	if err != nil || emptyResult["stack_deleted"] != true || emptyResult["stack_id"] != nil {
		t.Fatalf("restackRemainingAfterLanding empty = (%#v, %v)", emptyResult, err)
	}
	persistMode = "error"
	if _, err = restackRemainingAfterLanding("alice", "demo", "main", remaining); err == nil || !strings.Contains(err.Error(), "persist failed") {
		t.Fatalf("restackRemainingAfterLanding persist error = %v", err)
	}
	persistMode = ""
	t.Setenv("COMMANDS_STACK_H_LOCAL", "")
	if _, err = restackRemainingAfterLanding("alice", "demo", "main", []stackLandChange{{Branch: "smithers/missing", ChangeID: "missing", PRNumber: 4}}); err == nil || !strings.Contains(err.Error(), "Local stack is missing") {
		t.Fatalf("restackRemainingAfterLanding missing local = %v", err)
	}

	t.Setenv("COMMANDS_STACK_H_FAIL", "rebase")
	if _, err = restackSubmitted("alice", "demo", "main", []submittedStackChange{{Branch: "smithers/bbb22222", ChangeID: "bbb22222", PRNumber: 2}}, nil); err == nil || !strings.Contains(err.Error(), "rebase failed") {
		t.Fatalf("restackSubmitted rebase error = %v", err)
	}
	t.Setenv("COMMANDS_STACK_H_FAIL", "set")
	if _, err = restackSubmitted("alice", "demo", "main", []submittedStackChange{{Branch: "smithers/bbb22222", ChangeID: "bbb22222", PRNumber: 2}}, nil); err == nil || !strings.Contains(err.Error(), "set failed") {
		t.Fatalf("restackSubmitted set error = %v", err)
	}
	t.Setenv("COMMANDS_STACK_H_FAIL", "push-diverged")
	if _, err = restackSubmitted("alice", "demo", "main", []submittedStackChange{{Branch: "smithers/bbb22222", ChangeID: "bbb22222", PRNumber: 2}}, nil); err == nil || !strings.Contains(err.Error(), "diverged after fetch") {
		t.Fatalf("restackSubmitted diverged = %v", err)
	}
	t.Setenv("COMMANDS_STACK_H_FAIL", "push-other")
	if _, err = restackSubmitted("alice", "demo", "main", []submittedStackChange{{Branch: "smithers/bbb22222", ChangeID: "bbb22222", PRNumber: 2}}, nil); err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("restackSubmitted push error = %v", err)
	}
	t.Setenv("COMMANDS_STACK_H_FAIL", "")

	active, err := buildStackStatus("alice", "demo", "main", map[string]any{
		"id": 7,
		"changes": []any{
			map[string]any{"change_id": "bbb22222", "position": 0, "pr_number": 2, "review_status": "approved", "ci_status": "passing"},
			map[string]any{"change_id": "orphan", "position": 1, "pr_number": 0},
		},
	})
	if err != nil || len(arrayValue(active["changes"])) != 3 {
		t.Fatalf("buildStackStatus local+unmatched = (%#v, %v)", active, err)
	}
	if _, err := enrichStatusChangeWithGitHub("alice", "demo", map[string]any{"pr_number": 2, "ci_status": "passing", "review_status": "approved"}, true); err == nil || !strings.Contains(err.Error(), "could not read check runs for PR #2") {
		t.Fatalf("strict enrichment failure = %v", err)
	}
	if noPR, err := enrichStatusChangeWithGitHub("alice", "demo", map[string]any{"change_id": "no-pr"}, true); err != nil || noPR["change_id"] != "no-pr" {
		t.Fatalf("enrichStatusChangeWithGitHub no PR = (%#v, %v)", noPR, err)
	}

	if title, body := splitDescription("fallback-title", "Title only"); title != "Title only" || body != "" {
		t.Fatalf("splitDescription title only = %q, %q", title, body)
	}
	if stripped := stripExistingStackBlock("before\n" + stackMarkerStart + "\nno end"); stripped != "before\n"+stackMarkerStart+"\nno end" {
		t.Fatalf("stripExistingStackBlock missing end = %q", stripped)
	}
	if got := formatStackSyncSummary("alice", "demo", "main", map[string]any{"stack_found": true, "stack_deleted": true, "merged": []any{map[string]any{"pr_number": 1}}}); !strings.Contains(got, "Backend stack mapping removed") {
		t.Fatalf("formatStackSyncSummary deleted = %q", got)
	}
	if got := formatStackLandSummary("alice", "demo", "main", map[string]any{"stack_found": true, "landed": []any{map[string]any{"pr_number": 1}}, "remaining": []any{map[string]any{"pr_number": 2}}}); !strings.Contains(got, "Remaining PRs: #2") {
		t.Fatalf("formatStackLandSummary remaining = %q", got)
	}
	if got := stackPRList([]any{map[string]any{"name": "none"}}); got != "(none)" {
		t.Fatalf("stackPRList no PR parts = %q", got)
	}
	if got := formatStackStatusSummary("alice", "demo", "main", map[string]any{"stack_id": 1, "target": "main", "changes": []any{}}); !strings.Contains(got, "no local stack") {
		t.Fatalf("formatStackStatusSummary no changes = %q", got)
	}
	if got := formatStackStatusSummary("alice", "demo", "main", map[string]any{"stack_id": 1, "target": "main", "changes": []any{map[string]any{"change_id": "abc123", "description": "Not submitted"}}}); !strings.Contains(got, "Not submitted") {
		t.Fatalf("formatStackStatusSummary no PR = %q", got)
	}
	if prStateIndicator("open") != "🟡" || ciIndicator("pending") != "🟡" {
		t.Fatal("default indicators changed")
	}
	status, reviewers := aggregateReviewStatus([]any{map[string]any{"user": map[string]any{"login": "Ada"}, "state": "APPROVED"}})
	if status != "approved" || len(reviewers) != 1 {
		t.Fatalf("aggregateReviewStatus approved = %q %#v", status, reviewers)
	}
}
