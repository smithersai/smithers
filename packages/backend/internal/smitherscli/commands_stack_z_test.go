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

func commandsStackZServe(t *testing.T, argv ...string) string {
	t.Helper()
	var stdout bytes.Buffer
	if err := stackCommand().ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("stack %v returned error: %v\n%s", argv, err, stdout.String())
	}
	return stdout.String()
}

func commandsStackZServeErr(t *testing.T, want string, argv ...string) {
	t.Helper()
	var stdout bytes.Buffer
	err := stackCommand().ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout})
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("stack %v error = %v, want contains %q\n%s", argv, err, want, stdout.String())
	}
}

func commandsStackZInstallFakeJj(t *testing.T) {
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
  if [ "${COMMANDS_STACK_Z_FAIL:-}" = "fetch" ]; then printf 'fetch failed\n' >&2; exit 2; fi
  exit 0
fi
if printf '%s' "$args" | grep -q 'author.name'; then
  printf 'Stack Author\tauthor@example.com\n'
  exit 0
fi
if printf '%s' "$args" | grep -q 'rebase'; then
  if [ "${COMMANDS_STACK_Z_FAIL:-}" = "rebase" ]; then printf 'rebase failed\n' >&2; exit 3; fi
  exit 0
fi
if printf '%s' "$args" | grep -q 'bookmark set'; then
  if [ "${COMMANDS_STACK_Z_FAIL:-}" = "set" ]; then printf 'set failed\n' >&2; exit 4; fi
  exit 0
fi
if printf '%s' "$args" | grep -q 'git push'; then
  case "${COMMANDS_STACK_Z_FAIL:-}" in
    push-diverged) printf 'remote bookmark unexpectedly moved; run jj git fetch\n' >&2; exit 5 ;;
    push-other) printf 'permission denied\n' >&2; exit 6 ;;
  esac
  exit 0
fi
if printf '%s' "$args" | grep -q 'commit_id' && printf '%s' "$args" | grep -q '::@'; then
  case "${COMMANDS_STACK_Z_LOCAL:-two}" in
    empty) exit 0 ;;
    error) printf 'local stack failed\n' >&2; exit 7 ;;
    one) printf 'aaa11111\tcommit-a\n' ;;
    *) printf 'aaa11111\tcommit-a\nbbb22222\tcommit-b\n' ;;
  esac
  exit 0
fi
if printf '%s' "$args" | grep -q 'description'; then
  if [ "${COMMANDS_STACK_Z_DESC_FAIL:-}" = "1" ]; then printf 'description failed\n' >&2; exit 8; fi
  case "$args" in
    *aaa11111*) printf 'First change\n\nFirst body\n' ;;
    *bbb22222*) printf 'Second change\n\nSecond body\n' ;;
    *) printf 'Mapped change\n\nMapped body\n' ;;
  esac
  exit 0
fi
exit 0
`
	if err := os.WriteFile(filepath.Join(binDir, "jj"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func commandsStackZServers(t *testing.T) (*httptest.Server, *httptest.Server) {
	t.Helper()
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		target := r.URL.Query().Get("target_ref")
		if r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/github-proxy" {
			switch os.Getenv("COMMANDS_STACK_Z_PROXY") {
			case "error":
				w.WriteHeader(http.StatusBadGateway)
				fmt.Fprint(w, `{"message":"proxy failed"}`)
			case "array":
				fmt.Fprint(w, `[{"number":1}]`)
			case "unsupported":
				fmt.Fprint(w, `"unsupported"`)
			default:
				fmt.Fprint(w, `{"number":1,"state":"open"}`)
			}
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/stacks/active" {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if stringValue(body["target_ref"]) == "persist-error" {
				w.WriteHeader(http.StatusConflict)
				fmt.Fprint(w, `{"message":"persist failed"}`)
				return
			}
			fmt.Fprint(w, `{"id":77}`)
			return
		}
		if r.Method == http.MethodDelete && r.URL.Path == "/api/repos/alice/demo/stacks/active" {
			if target == "delete-error" {
				w.WriteHeader(http.StatusConflict)
				fmt.Fprint(w, `{"message":"delete failed"}`)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodGet || r.URL.Path != "/api/repos/alice/demo/stacks/active" {
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing backend"}`)
			return
		}
		switch target {
		case "error":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"stack failed"}`)
		case "none", "submit-new", "submit-invalid-pr", "submit-create-error", "submit-body-error":
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"none"}`)
		case "bad-pr":
			fmt.Fprint(w, `{"id":1,"changes":[{"change_id":"aaa11111","position":0}]}`)
		case "pull-error":
			fmt.Fprint(w, `{"id":1,"changes":[{"change_id":"aaa11111","position":0,"pr_number":500}]}`)
		case "missing-local":
			fmt.Fprint(w, `{"id":1,"changes":[{"change_id":"missing","position":0,"pr_number":2}]}`)
		case "merged", "delete-error":
			fmt.Fprint(w, `{"id":1,"changes":[{"change_id":"aaa11111","branch_name":"smithers/aaa11111","position":0,"pr_number":1}]}`)
		case "land-open":
			fmt.Fprint(w, `{"id":1,"changes":[{"change_id":"bbb22222","branch_name":"smithers/bbb22222","position":0,"pr_number":2,"pr_state":"open","ci_status":"passing","review_status":"approved"}]}`)
		case "land-two-open":
			fmt.Fprint(w, `{"id":1,"changes":[{"change_id":"aaa11111","branch_name":"smithers/aaa11111","position":0,"pr_number":2,"pr_state":"open","ci_status":"passing","review_status":"approved"},{"change_id":"bbb22222","branch_name":"smithers/bbb22222","position":1,"pr_number":3,"pr_state":"open","ci_status":"passing","review_status":"approved"}]}`)
		case "persist-error":
			fmt.Fprint(w, `{"id":1,"changes":[{"change_id":"aaa11111","branch_name":"smithers/aaa11111","position":0,"pr_number":2}]}`)
		case "submit-update":
			fmt.Fprint(w, `{"id":1,"changes":[{"change_id":"aaa11111","branch_name":"smithers/aaa11111","position":0,"pr_number":2}]}`)
		case "submit-patch-error":
			fmt.Fprint(w, `{"id":1,"changes":[{"change_id":"aaa11111","branch_name":"smithers/aaa11111","position":0,"pr_number":500}]}`)
		case "unsubmit-branch-error":
			fmt.Fprint(w, `{"id":1,"changes":[{"change_id":"aaa11111","branch_name":"protected","position":0}]}`)
		case "land-merge-error":
			fmt.Fprint(w, `{"id":1,"changes":[{"change_id":"bbb22222","branch_name":"smithers/bbb22222","position":0,"pr_number":24,"pr_state":"open","ci_status":"passing","review_status":"approved"}]}`)
		default:
			fmt.Fprint(w, `{"id":1,"state":"active","target_ref":"main","changes":[{"change_id":"aaa11111","branch_name":"smithers/aaa11111","position":0,"pr_number":1,"pr_state":"open","ci_status":"passing","review_status":"approved"},{"change_id":"bbb22222","branch_name":"smithers/bbb22222","position":1,"pr_number":2,"pr_state":"open","ci_status":"passing","review_status":"approved"}]}`)
		}
	}))
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		key := r.Method + " " + r.URL.Path
		switch {
		case key == "POST /repos/alice/demo/pulls":
			switch os.Getenv("COMMANDS_STACK_Z_GH") {
			case "post-error":
				w.WriteHeader(http.StatusInternalServerError)
				fmt.Fprint(w, `{"message":"create failed"}`)
				return
			case "post-invalid":
				fmt.Fprint(w, `{"state":"open"}`)
				return
			case "body-patch-error":
				fmt.Fprint(w, `{"number":11,"state":"open","html_url":"https://github.local/pr/11"}`)
				return
			}
			fmt.Fprint(w, `{"number":10,"state":"open","html_url":"https://github.local/pr/10"}`)
		case key == "PATCH /repos/alice/demo/pulls/11":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"body patch failed"}`)
		case key == "PATCH /repos/alice/demo/pulls/10":
			fmt.Fprint(w, `{"state":"open","html_url":"https://github.local/pr/10-updated"}`)
		case key == "PATCH /repos/alice/demo/pulls/2":
			fmt.Fprint(w, `{"number":2,"state":"open","html_url":"https://github.local/pr/2-updated"}`)
		case key == "PATCH /repos/alice/demo/pulls/3":
			fmt.Fprint(w, `{"number":3,"state":"open","html_url":"https://github.local/pr/3-updated"}`)
		case key == "GET /repos/alice/demo/pulls/1":
			fmt.Fprint(w, `{"state":"closed","merged":true,"html_url":"https://github.local/pr/1","head":{"sha":"sha-1"}}`)
		case key == "GET /repos/alice/demo/pulls/2":
			fmt.Fprint(w, `{"state":"open","merged":false,"mergeable":true,"html_url":"https://github.local/pr/2","head":{"sha":"sha-2"}}`)
		case key == "GET /repos/alice/demo/pulls/3":
			fmt.Fprint(w, `{"state":"open","merged":false,"mergeable":true,"html_url":"https://github.local/pr/3","head":{"sha":"sha-2"}}`)
		case key == "GET /repos/alice/demo/pulls/500":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"pull failed"}`)
		case key == "PATCH /repos/alice/demo/pulls/500":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"patch failed"}`)
		case key == "DELETE /repos/alice/demo/git/refs/heads/protected":
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprint(w, `{"message":"protected branch"}`)
		case strings.HasPrefix(key, "DELETE /repos/alice/demo/git/refs/heads/"):
			w.WriteHeader(http.StatusNoContent)
		case key == "GET /repos/alice/demo/commits/sha-1/check-runs":
			fmt.Fprint(w, `{"check_runs":[{"status":"completed","conclusion":"success"}]}`)
		case key == "GET /repos/alice/demo/commits/sha-2/check-runs":
			fmt.Fprint(w, `{"check_runs":[{"status":"completed","conclusion":"success"}]}`)
		case strings.Contains(key, "/check-runs"):
			fmt.Fprint(w, `{"check_runs":[{"status":"completed","conclusion":"success"},{"status":"queued"}]}`)
		case key == "GET /repos/alice/demo/pulls/1/reviews":
			fmt.Fprint(w, `[{"user":{"login":"Ada"},"state":"APPROVED"}]`)
		case key == "GET /repos/alice/demo/pulls/2/reviews":
			fmt.Fprint(w, `[{"user":{"login":"Ada"},"state":"APPROVED"}]`)
		case key == "GET /repos/alice/demo/pulls/3/reviews":
			fmt.Fprint(w, `[{"user":{"login":"Ada"},"state":"APPROVED"}]`)
		case key == "GET /repos/alice/demo/pulls/24/reviews":
			fmt.Fprint(w, `[{"user":{"login":"Ada"},"state":"APPROVED"}]`)
		case key == "GET /repos/alice/demo/pulls/24":
			fmt.Fprint(w, `{"state":"open","merged":false,"mergeable":true,"html_url":"https://github.local/pr/24","head":{"sha":"sha-1"}}`)
		case key == "PUT /repos/alice/demo/pulls/2/merge":
			fmt.Fprint(w, `{"merged":true}`)
		case strings.Contains(key, "/reviews"):
			fmt.Fprint(w, `[{"user":{"login":"Ada"},"state":"APPROVED"},{"user":{"login":"Ben"},"state":"CHANGES_REQUESTED"},{"user":{},"state":"APPROVED"},{"user":{"login":"Skip"},"state":"COMMENTED"}]`)
		case key == "PUT /repos/alice/demo/pulls/24/merge":
			w.WriteHeader(http.StatusConflict)
			fmt.Fprint(w, `{"message":"merge conflict"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprintf(w, `{"message":"missing github %s"}`, key)
		}
	}))
	t.Cleanup(backend.Close)
	t.Cleanup(github.Close)
	return backend, github
}

func TestCommandsStack_Z_CommandAndSyncErrorBranches(t *testing.T) {
	commandsStackZInstallFakeJj(t)
	backend, github := commandsStackZServers(t)
	commandsStackHSetAPIConfig(t, backend.URL)
	t.Setenv("GITHUB_TOKEN", "stack-z-gh")
	t.Setenv("SMITHERS_GITHUB_API_URL", github.URL)

	commandsStackZServeErr(t, "Invalid repo format", "submit", "--repo", "bad")
	commandsStackZServeErr(t, "stack failed", "submit", "--repo", "alice/demo", "--target", "error")
	t.Setenv("COMMANDS_STACK_Z_LOCAL", "error")
	commandsStackZServeErr(t, "local stack failed", "submit", "--repo", "alice/demo", "--target", "submit-new")
	t.Setenv("COMMANDS_STACK_Z_LOCAL", "empty")
	commandsStackZServeErr(t, "No non-empty changes", "submit", "--repo", "alice/demo", "--target", "submit-new")
	t.Setenv("COMMANDS_STACK_Z_LOCAL", "one")
	t.Setenv("COMMANDS_STACK_Z_FAIL", "set")
	commandsStackZServeErr(t, "set failed", "submit", "--repo", "alice/demo", "--target", "submit-new")
	t.Setenv("COMMANDS_STACK_Z_FAIL", "push-diverged")
	commandsStackZServeErr(t, "has diverged", "submit", "--repo", "alice/demo", "--target", "submit-new")
	t.Setenv("COMMANDS_STACK_Z_FAIL", "push-other")
	commandsStackZServeErr(t, "permission denied", "submit", "--repo", "alice/demo", "--target", "submit-new")
	t.Setenv("COMMANDS_STACK_Z_FAIL", "")
	commandsStackZServe(t, "submit", "--repo", "alice/demo", "--target", "submit-update")
	commandsStackZServe(t, "submit", "--repo", "alice/demo", "--target", "submit-new")
	commandsStackZServeErr(t, "patch failed", "submit", "--repo", "alice/demo", "--target", "submit-patch-error")
	t.Setenv("COMMANDS_STACK_Z_GH", "post-error")
	commandsStackZServeErr(t, "create failed", "submit", "--repo", "alice/demo", "--target", "submit-create-error")
	t.Setenv("COMMANDS_STACK_Z_GH", "post-invalid")
	commandsStackZServeErr(t, "valid PR number", "submit", "--repo", "alice/demo", "--target", "submit-invalid-pr")
	t.Setenv("COMMANDS_STACK_Z_GH", "body-patch-error")
	commandsStackZServeErr(t, "body patch failed", "submit", "--repo", "alice/demo", "--target", "submit-body-error")
	t.Setenv("COMMANDS_STACK_Z_GH", "")
	commandsStackZServeErr(t, "persist failed", "submit", "--repo", "alice/demo", "--target", "persist-error")

	commandsStackZServeErr(t, "Invalid repo format", "unsubmit", "--repo", "bad")
	commandsStackZServeErr(t, "stack failed", "unsubmit", "--repo", "alice/demo", "--target", "error")
	commandsStackZServe(t, "unsubmit", "--repo", "alice/demo", "--target", "none", "--json")
	commandsStackZServe(t, "unsubmit", "--repo", "alice/demo", "--target", "none")
	commandsStackZServeErr(t, "pull failed", "unsubmit", "--repo", "alice/demo", "--target", "submit-patch-error")
	commandsStackZServeErr(t, "protected branch", "unsubmit", "--repo", "alice/demo", "--target", "unsubmit-branch-error")
	commandsStackZServeErr(t, "delete failed", "unsubmit", "--repo", "alice/demo", "--target", "delete-error")
	commandsStackZServe(t, "unsubmit", "--repo", "alice/demo", "--target", "main")

	commandsStackZServeErr(t, "Invalid repo format", "status", "--repo", "bad")
	commandsStackZServeErr(t, "stack failed", "status", "--repo", "alice/demo", "--target", "error")
	oldBuildStatus := buildStackStatusForCommand
	t.Cleanup(func() { buildStackStatusForCommand = oldBuildStatus })
	buildStackStatusForCommand = func(string, string, string, any) (map[string]any, error) {
		return nil, fmt.Errorf("status build failed")
	}
	commandsStackZServeErr(t, "status build failed", "status", "--repo", "alice/demo", "--target", "none")
	buildStackStatusForCommand = oldBuildStatus
	commandsStackZServe(t, "status", "--repo", "alice/demo", "--target", "none")

	commandsStackZServeErr(t, "Invalid repo format", "sync", "--repo", "bad")
	t.Setenv("COMMANDS_STACK_Z_FAIL", "fetch")
	commandsStackZServeErr(t, "fetch failed", "sync", "--repo", "alice/demo", "--target", "none")
	t.Setenv("COMMANDS_STACK_Z_FAIL", "")
	commandsStackZServeErr(t, "stack failed", "sync", "--repo", "alice/demo", "--target", "error")
	t.Setenv("COMMANDS_STACK_Z_LOCAL", "error")
	commandsStackZServeErr(t, "local stack failed", "sync", "--repo", "alice/demo", "--target", "main")
	t.Setenv("COMMANDS_STACK_Z_LOCAL", "one")
	commandsStackZServe(t, "sync", "--repo", "alice/demo", "--target", "none")
	commandsStackZServeErr(t, "Stack mapping for change", "sync", "--repo", "alice/demo", "--target", "bad-pr")
	commandsStackZServeErr(t, "pull failed", "sync", "--repo", "alice/demo", "--target", "pull-error")
	commandsStackZServeErr(t, "Local stack is missing", "sync", "--repo", "alice/demo", "--target", "missing-local")
	commandsStackZServe(t, "sync", "--repo", "alice/demo", "--target", "merged")
	commandsStackZServeErr(t, "delete failed", "sync", "--repo", "alice/demo", "--target", "delete-error")
	t.Setenv("COMMANDS_STACK_Z_FAIL", "rebase")
	commandsStackZServeErr(t, "rebase failed", "sync", "--repo", "alice/demo", "--target", "persist-error")
	t.Setenv("COMMANDS_STACK_Z_FAIL", "")
	commandsStackZServeErr(t, "persist failed", "sync", "--repo", "alice/demo", "--target", "persist-error")
}

func TestCommandsStack_Z_LandAndHelperBranches(t *testing.T) {
	commandsStackZInstallFakeJj(t)
	backend, github := commandsStackZServers(t)
	commandsStackHSetAPIConfig(t, backend.URL)
	t.Setenv("GITHUB_TOKEN", "stack-z-gh")
	t.Setenv("SMITHERS_GITHUB_API_URL", github.URL)

	commandsStackZServeErr(t, "Invalid repo format", "land", "--repo", "bad")
	commandsStackZServeErr(t, "stack failed", "land", "--repo", "alice/demo", "--target", "error")
	commandsStackZServe(t, "land", "--repo", "alice/demo", "--target", "none", "--json")
	commandsStackZServe(t, "land", "--repo", "alice/demo", "--target", "none")
	commandsStackZServeErr(t, "Stack mapping for change", "land", "--repo", "alice/demo", "--target", "bad-pr")
	commandsStackZServeErr(t, "PR is closed", "land", "--repo", "alice/demo", "--target", "main")

	oldSelect := selectStackLandCountForCommand
	t.Cleanup(func() { selectStackLandCountForCommand = oldSelect })
	selectStackLandCountForCommand = func([]stackLandChange, bool, string, bool) (int, error) {
		return 2, nil
	}
	commandsStackZServeErr(t, "Stack changed while landing", "land", "--repo", "alice/demo", "--target", "land-open")
	selectStackLandCountForCommand = oldSelect

	oldEnrich := enrichStatusChangeForRefresh
	t.Cleanup(func() { enrichStatusChangeForRefresh = oldEnrich })
	enrichStatusChangeForRefresh = func(string, string, map[string]any, bool) (map[string]any, error) {
		return nil, fmt.Errorf("refresh failed")
	}
	if _, err := refreshStackLandChange("alice", "demo", stackLandChange{ChangeID: "aaa", PRNumber: 1}); err == nil || !strings.Contains(err.Error(), "refresh failed") {
		t.Fatalf("refreshStackLandChange seam error = %v", err)
	}
	enrichStatusChangeForRefresh = oldEnrich
	oldRefresh := refreshStackLandChangeForCommand
	t.Cleanup(func() { refreshStackLandChangeForCommand = oldRefresh })
	refreshStackLandChangeForCommand = func(string, string, stackLandChange) (stackLandChange, error) {
		return stackLandChange{}, fmt.Errorf("loop refresh failed")
	}
	commandsStackZServeErr(t, "loop refresh failed", "land", "--repo", "alice/demo", "--target", "land-open")
	refreshStackLandChangeForCommand = func(string, string, stackLandChange) (stackLandChange, error) {
		return stackLandChange{ChangeID: "bbb22222", PRNumber: 2, ReviewStatus: "pending", CIStatus: "passing", PRState: "open"}, nil
	}
	commandsStackZServeErr(t, "pending review", "land", "--repo", "alice/demo", "--target", "land-open")
	refreshStackLandChangeForCommand = oldRefresh
	commandsStackZServeErr(t, "merge conflict", "land", "--repo", "alice/demo", "--target", "land-merge-error")
	t.Setenv("COMMANDS_STACK_Z_FAIL", "rebase")
	commandsStackZServeErr(t, "rebase failed", "land", "--repo", "alice/demo", "--target", "land-two-open")
	t.Setenv("COMMANDS_STACK_Z_FAIL", "")
	commandsStackZServe(t, "land", "--repo", "alice/demo", "--target", "land-open", "--json")
	commandsStackZServe(t, "land", "--repo", "alice/demo", "--target", "land-open")

	if _, err := buildStackLandChanges("alice", "demo", []map[string]any{{"change_id": ""}}); err == nil || !strings.Contains(err.Error(), "Unable to resolve branch") {
		t.Fatalf("buildStackLandChanges branch error = %v", err)
	}
	if _, err := buildStackLandChanges("alice", "demo", []map[string]any{{"change_id": "aaa"}}); err == nil || !strings.Contains(err.Error(), "missing pr_number") {
		t.Fatalf("buildStackLandChanges pr error = %v", err)
	}
	enrichStatusChangeForRefresh = func(string, string, map[string]any, bool) (map[string]any, error) {
		return nil, fmt.Errorf("build refresh failed")
	}
	if _, err := buildStackLandChanges("alice", "demo", []map[string]any{{"change_id": "aaa", "pr_number": 1}}); err == nil || !strings.Contains(err.Error(), "build refresh failed") {
		t.Fatalf("buildStackLandChanges refresh error = %v", err)
	}
	enrichStatusChangeForRefresh = oldEnrich

	changes := []stackLandChange{
		{ChangeID: "abc111", PRNumber: 1, ReviewStatus: "approved", CIStatus: "passing", PRState: "open"},
		{ChangeID: "abc222", PRNumber: 2, ReviewStatus: "approved", CIStatus: "passing", PRState: "open"},
	}
	if _, err := selectStackLandCount(nil, false, "", false); err == nil || !strings.Contains(err.Error(), "no changes") {
		t.Fatalf("select empty = %v", err)
	}
	if _, err := selectStackLandCount(changes, false, "abc", true); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("select ambiguous = %v", err)
	}
	if _, err := selectStackLandCount(changes, false, "missing", true); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("select missing = %v", err)
	}
	if count, err := selectStackLandCount(changes, false, "abc222", true); err != nil || count != 2 {
		t.Fatalf("select requested success = %d, %v", count, err)
	}
	if _, err := selectStackLandCount([]stackLandChange{{ChangeID: "bad", PRNumber: 1, ReviewStatus: "pending", CIStatus: "passing", PRState: "open"}}, true, "", false); err == nil || !strings.Contains(err.Error(), "pending review") {
		t.Fatalf("select all none = %v", err)
	}
	if _, err := selectStackLandCount([]stackLandChange{{ChangeID: "bad", PRNumber: 1, ReviewStatus: "pending", CIStatus: "passing", PRState: "open"}}, false, "", false); err == nil || !strings.Contains(err.Error(), "pending review") {
		t.Fatalf("select default bad = %v", err)
	}

	if err := mergePullRequest("alice", "demo", 24); err == nil || !strings.Contains(err.Error(), "merge conflict") {
		t.Fatalf("merge conflict = %v", err)
	}
	oldMethods := stackMergeMethods
	t.Cleanup(func() { stackMergeMethods = oldMethods })
	stackMergeMethods = nil
	if err := mergePullRequest("alice", "demo", 25); err == nil || !strings.Contains(err.Error(), "Failed to merge PR #25.") {
		t.Fatalf("merge no methods = %v", err)
	}
	stackMergeMethods = oldMethods

	twoSubmitted := []submittedStackChange{
		{Branch: "smithers/aaa11111", ChangeID: "aaa11111", DescriptionBody: "First body", PRNumber: 2, Title: "First change"},
		{Branch: "smithers/bbb22222", ChangeID: "bbb22222", DescriptionBody: "Second body", PRNumber: 3, Title: "Second change"},
	}
	updated, err := restackSubmitted("alice", "demo", "main", twoSubmitted, nil)
	if err != nil || len(updated) != 2 || updated[1].PRURL != "https://github.local/pr/3-updated" {
		t.Fatalf("restackSubmitted two = %#v %v", updated, err)
	}
	t.Setenv("COMMANDS_STACK_Z_FAIL", "rebase")
	if _, err := restackSubmitted("alice", "demo", "main", twoSubmitted[:1], nil); err == nil || !strings.Contains(err.Error(), "rebase failed") {
		t.Fatalf("restackSubmitted rebase error = %v", err)
	}
	t.Setenv("COMMANDS_STACK_Z_FAIL", "")
	if _, err := restackSubmitted("alice", "demo", "main", []submittedStackChange{{Branch: "smithers/fail", ChangeID: "aaa11111", PRNumber: 500, Title: "Fail"}}, nil); err == nil || !strings.Contains(err.Error(), "patch failed") {
		t.Fatalf("restackSubmitted patch error = %v", err)
	}
	if _, err := restackRemainingAfterLanding("alice", "demo", "delete-error", nil); err == nil || !strings.Contains(err.Error(), "delete failed") {
		t.Fatalf("restackRemainingAfterLanding delete error = %v", err)
	}
	t.Setenv("COMMANDS_STACK_Z_LOCAL", "error")
	if _, err := restackRemainingAfterLanding("alice", "demo", "main", []stackLandChange{{Branch: "smithers/aaa11111", ChangeID: "aaa11111", PRNumber: 2, PRState: "open"}}); err == nil || !strings.Contains(err.Error(), "local stack failed") {
		t.Fatalf("restackRemainingAfterLanding local error = %v", err)
	}
	t.Setenv("COMMANDS_STACK_Z_LOCAL", "one")

	if _, _, ok := githubRepoFromAPIPath("%"); ok {
		t.Fatal("githubRepoFromAPIPath accepted invalid URL")
	}
	if _, _, ok := githubRepoFromAPIPath("/repos/%zz/demo"); ok {
		t.Fatal("githubRepoFromAPIPath accepted invalid owner escape")
	}
	if _, _, ok := githubRepoFromAPIPath("/repos/alice/%zz"); ok {
		t.Fatal("githubRepoFromAPIPath accepted invalid repo escape")
	}
	oldPathUnescape := githubPathUnescape
	t.Cleanup(func() { githubPathUnescape = oldPathUnescape })
	githubPathUnescape = func(string) (string, error) {
		return "", fmt.Errorf("owner unescape failed")
	}
	if _, _, ok := githubRepoFromAPIPath("/repos/alice/demo"); ok {
		t.Fatal("githubRepoFromAPIPath accepted owner unescape failure")
	}
	unescapeCalls := 0
	githubPathUnescape = func(value string) (string, error) {
		unescapeCalls++
		if unescapeCalls == 2 {
			return "", fmt.Errorf("repo unescape failed")
		}
		return value, nil
	}
	if _, _, ok := githubRepoFromAPIPath("/repos/alice/demo"); ok {
		t.Fatal("githubRepoFromAPIPath accepted repo unescape failure")
	}
	githubPathUnescape = oldPathUnescape
	if _, err := githubAPIViaSmithersProxy(http.MethodGet, "/bad", nil); err == nil || !strings.Contains(err.Error(), "must target") {
		t.Fatalf("github proxy invalid path = %v", err)
	}
	commandsStackHSetAPIConfig(t, backend.URL)
	t.Setenv("GITHUB_TOKEN", "")
	proxied, err := githubAPI(http.MethodGet, "/repos/alice/demo/pulls/1", nil)
	if err != nil || intValue(proxied["number"], 0) != 1 {
		t.Fatalf("githubAPI proxy fallback = %#v %v", proxied, err)
	}
	t.Setenv("COMMANDS_STACK_Z_PROXY", "array")
	proxied, err = githubAPIViaSmithersProxy(http.MethodGet, "/repos/alice/demo/pulls", map[string]any{"ok": true})
	if err != nil || len(arrayValue(proxied["items"])) != 1 {
		t.Fatalf("github proxy array body = %#v %v", proxied, err)
	}
	t.Setenv("COMMANDS_STACK_Z_PROXY", "unsupported")
	if _, err := githubAPIViaSmithersProxy(http.MethodGet, "/repos/alice/demo/pulls", nil); err == nil || !strings.Contains(err.Error(), "unsupported") {
		t.Fatalf("github proxy unsupported = %v", err)
	}
	t.Setenv("COMMANDS_STACK_Z_PROXY", "error")
	if _, err := githubAPIViaSmithersProxy(http.MethodGet, "/repos/alice/demo/pulls", nil); err == nil || !strings.Contains(err.Error(), "proxy failed") {
		t.Fatalf("github proxy API error = %v", err)
	}
	t.Setenv("COMMANDS_STACK_Z_PROXY", "")
	t.Setenv("GITHUB_TOKEN", "stack-z-gh")
	t.Setenv("SMITHERS_GITHUB_API_URL", "http://127.0.0.1:1")
	if _, err := githubAPI(http.MethodGet, "/repos/alice/demo/pulls/1", nil); err == nil {
		t.Fatal("githubAPI accepted transport failure")
	}
	t.Setenv("SMITHERS_GITHUB_API_URL", "://bad-url")
	if _, err := githubAPI(http.MethodGet, "/repos/alice/demo/pulls/1", nil); err == nil {
		t.Fatal("githubAPI accepted invalid URL")
	}
	t.Setenv("SMITHERS_GITHUB_API_URL", github.URL)
	if title, body := splitDescription("fallback", " \n\t "); title != "fallback" || body != "" {
		t.Fatalf("splitDescription blank = %q %q", title, body)
	}
	if got := formatStackLandSummary("alice", "demo", "main", map[string]any{"stack_found": false}); !strings.Contains(got, "No active stack") {
		t.Fatalf("formatStackLandSummary inactive = %q", got)
	}
	t.Setenv("GITHUB_TOKEN", "")
	// With no GITHUB_TOKEN enrichment goes through the Smithers GitHub proxy,
	// and strict mode reports a proxy failure instead of inventing "pending".
	if proxied, err := enrichStatusChangeWithGitHub("alice", "demo", map[string]any{"pr_number": 1}, true); err != nil || proxied["pr_state"] != "open" {
		t.Fatalf("enrich no token strict via proxy = %#v %v", proxied, err)
	}
	t.Setenv("COMMANDS_STACK_Z_PROXY", "error")
	if _, err := enrichStatusChangeWithGitHub("alice", "demo", map[string]any{"pr_number": 1}, true); err == nil || !strings.Contains(err.Error(), "proxy failed") {
		t.Fatalf("enrich no token strict proxy error = %v", err)
	}
	t.Setenv("COMMANDS_STACK_Z_PROXY", "")
	t.Setenv("GITHUB_TOKEN", "stack-z-gh")
	if _, err := enrichStatusChangeWithGitHub("alice", "demo", map[string]any{"pr_number": 500}, true); err == nil || !strings.Contains(err.Error(), "could not read the pull request for PR #500") {
		t.Fatalf("enrich pull err strict = %v", err)
	}
	if lenient, err := enrichStatusChangeWithGitHub("alice", "demo", map[string]any{"pr_number": 500, "review_status": "approved"}, false); err != nil || lenient["review_status"] != "approved" {
		t.Fatalf("enrich pull err lenient = %#v %v", lenient, err)
	}
	reviewErrServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "/reviews") {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"reviews failed"}`)
			return
		}
		fmt.Fprint(w, `{"state":"open","head":{"sha":"sha"}}`)
	}))
	defer reviewErrServer.Close()
	t.Setenv("SMITHERS_GITHUB_API_URL", reviewErrServer.URL)
	if _, err := enrichStatusChangeWithGitHub("alice", "demo", map[string]any{"pr_number": 1}, true); err == nil || !strings.Contains(err.Error(), "reviews failed") {
		t.Fatalf("enrich review err strict = %v", err)
	}
	status, reviewers := aggregateReviewStatus([]any{
		map[string]any{"user": map[string]any{"login": ""}, "state": "APPROVED"},
		map[string]any{"user": map[string]any{"login": "Skip"}, "state": "COMMENTED"},
		map[string]any{"user": map[string]any{"login": "Ben"}, "state": "CHANGES_REQUESTED"},
	})
	if status != "changes_requested" || len(reviewers) != 1 {
		t.Fatalf("aggregateReviewStatus changes requested = %q %#v", status, reviewers)
	}
}
