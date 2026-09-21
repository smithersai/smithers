package smitherscli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func commandsStackCovSetAPIConfig(t *testing.T, apiURL string) {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_TOKEN", "smithers_stack_cov_token")
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commandsStackCovGitHubServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Setenv("GITHUB_TOKEN", "github_stack_cov_token")
	t.Setenv("SMITHERS_GITHUB_API_URL", server.URL)
	t.Cleanup(server.Close)
	return server
}

func commandsStackCovNoJj(t *testing.T) {
	t.Helper()
	binDir := t.TempDir()
	t.Setenv("PATH", binDir)
}

func TestCommandsStack_Cov_CommandConstructorsAndTargets(t *testing.T) {
	var stdout bytes.Buffer
	if err := stackCommand().ServeWithOptions([]string{"--help"}, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("stack help returned error: %v", err)
	}
	help := stdout.String()
	for _, command := range []string{"submit", "sync", "land", "status"} {
		if !strings.Contains(help, command) {
			t.Fatalf("stack help missing %q:\n%s", command, help)
		}
	}

	if stackSyncCommand(false).Handler == nil || stackLandCommand().Handler == nil {
		t.Fatal("expected sync and land command handlers")
	}
	if got := stackTarget(&incur.CommandContext{Options: map[string]any{"target": "  release/v1  "}}); got != "release/v1" {
		t.Fatalf("stackTarget trimmed value = %q", got)
	}
	if got := stackTarget(&incur.CommandContext{Options: map[string]any{"target": " \t "}}); got != "main" {
		t.Fatalf("stackTarget blank value = %q", got)
	}

	_, err := stackLandCommand().Handler(&incur.CommandContext{Options: map[string]any{"repo": "alice/demo", "change": ""}})
	if err == nil || !strings.Contains(err.Error(), "`--change` requires") {
		t.Fatalf("expected empty --change validation error, got %v", err)
	}
	_, err = stackLandCommand().Handler(&incur.CommandContext{Options: map[string]any{"repo": "alice/demo", "all": true, "change": "abc"}})
	if err == nil || !strings.Contains(err.Error(), "Specify only one") {
		t.Fatalf("expected mutually exclusive land options error, got %v", err)
	}
}

func TestCommandsStack_Cov_GitHubAPIAndClassifiers(t *testing.T) {
	requests := []string{}
	commandsStackCovGitHubServer(t, func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		if got := r.Header.Get("Authorization"); got != "Bearer github_stack_cov_token" {
			t.Fatalf("Authorization header = %q", got)
		}
		switch r.URL.Path {
		case "/repos/alice/demo/pulls":
			if r.Method != http.MethodPost {
				t.Fatalf("method for pulls = %s", r.Method)
			}
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("invalid request JSON: %v", err)
			}
			if payload["title"] != "Add feature" {
				t.Fatalf("request body title = %#v", payload["title"])
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"number":42,"state":"open"}`)
		case "/repos/alice/demo/issues":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `[{"number":1},{"number":2}]`)
		case "/repos/alice/demo/missing":
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"gone"}`)
		default:
			t.Fatalf("unexpected GitHub path: %s", r.URL.Path)
		}
	})

	pr, err := githubAPI(http.MethodPost, "/repos/alice/demo/pulls", map[string]any{"title": "Add feature"})
	if err != nil {
		t.Fatalf("githubAPI post returned error: %v", err)
	}
	if intValue(pr["number"], 0) != 42 {
		t.Fatalf("PR number = %#v", pr["number"])
	}
	list, err := githubAPI(http.MethodGet, "/repos/alice/demo/issues", nil)
	if err != nil {
		t.Fatalf("githubAPI array returned error: %v", err)
	}
	if len(arrayValue(list["items"])) != 2 {
		t.Fatalf("array response was not wrapped as items: %#v", list)
	}
	_, err = githubAPI(http.MethodGet, "/repos/alice/demo/missing", nil)
	if !githubNotFound(err) || !strings.Contains(err.Error(), "gone") {
		t.Fatalf("expected classified 404 APIError, got %T %v", err, err)
	}
	if len(requests) != 3 {
		t.Fatalf("requests = %v", requests)
	}

	if githubAuthSource() != "github_token" {
		t.Fatalf("expected github token auth source")
	}
	t.Setenv("GITHUB_TOKEN", "")
	if githubAuthSource() != "server_github_app_installation" {
		t.Fatalf("expected server auth source without GITHUB_TOKEN")
	}
	if !githubUnprocessableOrMissing(&APIError{Status: http.StatusUnprocessableEntity}) {
		t.Fatal("422 should be treated as unprocessable or missing")
	}
	if githubNotFound(errors.New("not api")) || githubUnprocessableOrMissing(&APIError{Status: http.StatusForbidden}) {
		t.Fatal("unexpected API error classification")
	}
}

func TestCommandsStack_Cov_GitHubProxyAndStackMappingRequests(t *testing.T) {
	calls := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.RequestURI())
		if got := r.Header.Get("Authorization"); got != "token smithers_stack_cov_token" {
			t.Fatalf("Authorization header = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/github-proxy":
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("invalid proxy body: %v", err)
			}
			if payload["path"] != "/repos/alice/demo/pulls" || payload["method"] != "GET" {
				t.Fatalf("proxy payload = %#v", payload)
			}
			fmt.Fprint(w, `[{"number":9}]`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/stacks/active":
			if r.URL.Query().Get("target_ref") != "release/v1" {
				t.Fatalf("target_ref query = %q", r.URL.Query().Get("target_ref"))
			}
			fmt.Fprint(w, `{"id":12,"target_ref":"release/v1"}`)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/repos/alice/demo/stacks/active":
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/stacks/active":
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("invalid mapping body: %v", err)
			}
			changes := arrayValue(payload["changes"])
			if len(changes) != 1 || objectValue(changes[0])["review_status"] != "approved" {
				t.Fatalf("persisted changes = %#v", changes)
			}
			fmt.Fprint(w, `{"id":99}`)
		default:
			t.Fatalf("unexpected API request: %s %s", r.Method, r.URL.RequestURI())
		}
	}))
	defer server.Close()
	commandsStackCovSetAPIConfig(t, server.URL)
	t.Setenv("GITHUB_TOKEN", "")

	proxied, err := githubAPIViaSmithersProxy(http.MethodGet, "/repos/alice/demo/pulls", nil)
	if err != nil {
		t.Fatalf("githubAPIViaSmithersProxy returned error: %v", err)
	}
	if len(arrayValue(proxied["items"])) != 1 {
		t.Fatalf("expected array proxy response to be wrapped, got %#v", proxied)
	}
	if _, err := githubAPIViaSmithersProxy(http.MethodGet, "/user", nil); err == nil || !strings.Contains(err.Error(), "must target") {
		t.Fatalf("expected invalid proxy path error, got %v", err)
	}

	existing, err := loadExistingStack("alice", "demo", "release/v1")
	if err != nil {
		t.Fatalf("loadExistingStack returned error: %v", err)
	}
	if intValue(objectValue(existing)["id"], 0) != 12 {
		t.Fatalf("loaded stack = %#v", existing)
	}
	if err := deleteActiveStackMapping("alice", "demo", "release/v1"); err != nil {
		t.Fatalf("404 delete should be ignored: %v", err)
	}
	persisted, err := persistStackMapping("alice", "demo", "release/v1", []submittedStackChange{{
		Branch: "smithers/abc", ChangeID: "abcdef", Position: 0, PRNumber: 7, PRState: "open",
	}}, []stackLandChange{{CIStatus: "passing", ReviewStatus: "approved"}})
	if err != nil {
		t.Fatalf("persistStackMapping returned error: %v", err)
	}
	if intValue(objectValue(persisted)["id"], 0) != 99 {
		t.Fatalf("persisted response = %#v", persisted)
	}
	if len(calls) != 4 {
		t.Fatalf("calls = %v", calls)
	}
}

func TestCommandsStack_Cov_ParsingFormattingAndSummaries(t *testing.T) {
	changes := []submittedStackChange{
		{Branch: "smithers/aaaaaaaa", ChangeID: "aaaaaaaa1111", PRNumber: 10, Title: "First", Status: "created", PRURL: "https://example/pr/10"},
		{Branch: "smithers/bbbbbbbb", ChangeID: "bbbbbbbb2222", PRNumber: 11, Title: "Second", Status: "updated", PRURL: "https://example/pr/11"},
	}
	if shortChangeID("123456789") != "12345678" || shortChangeID("1234") != "1234" {
		t.Fatal("shortChangeID did not truncate only long IDs")
	}
	title, body := splitDescription("change-id", "\n Feature title \n\n Details\n")
	if title != "Feature title" || body != "Details" {
		t.Fatalf("splitDescription = %q, %q", title, body)
	}
	title, body = splitDescription("fallback", " \n ")
	if title != "fallback" || body != "" {
		t.Fatalf("empty splitDescription = %q, %q", title, body)
	}
	for _, message := range []string{"last fetched remote moved", "run jj git fetch", "remote bookmark changed", "unexpectedly moved"} {
		if !isDivergedPushError(errors.New(message)) {
			t.Fatalf("expected diverged push error for %q", message)
		}
	}
	if isDivergedPushError(nil) || isDivergedPushError(errors.New("permission denied")) {
		t.Fatal("unexpected diverged push classification")
	}

	block := renderStackBlock(changes, "bbbbbbbb2222")
	if !strings.Contains(block, "**Second**") || !strings.Contains(block, "Do not merge") {
		t.Fatalf("renderStackBlock missing current marker or warning:\n%s", block)
	}
	bodyWithBlock := "Intro\n\n" + block + "\n\nTail"
	if stripped := stripExistingStackBlock(bodyWithBlock); stripped != "Intro\n\nTail" {
		t.Fatalf("stripExistingStackBlock = %q", stripped)
	}
	if composed := composePRBody("Old body\n\n"+block, "NEW BLOCK"); composed != "Old body\n\nNEW BLOCK" {
		t.Fatalf("composePRBody replaced block incorrectly: %q", composed)
	}
	if composePRBody("", "only block") != "only block" {
		t.Fatal("empty description should return stack block")
	}

	byID := stackChangesByID([]any{map[string]any{"change_id": "a", "pr_number": 1}, map[string]any{"change_id": " "}})
	if intValue(byID["a"]["pr_number"], 0) != 1 || len(byID) != 1 {
		t.Fatalf("stackChangesByID = %#v", byID)
	}
	if got := stackSubmittedField(changes, "change_id"); len(got) != 2 || got[0] != "aaaaaaaa1111" {
		t.Fatalf("stackSubmittedField change_id = %#v", got)
	}
	if got := stackSubmittedField(changes, "pr_number"); len(got) != 2 || got[1] != 11 {
		t.Fatalf("stackSubmittedField pr_number = %#v", got)
	}
	t.Setenv("GITHUB_TOKEN", "token")
	submitted := stackSubmittedChanges(changes)
	if submitted[0]["auth_source"] != "github_token" || submitted[0]["push_target"] != "origin/smithers/aaaaaaaa" {
		t.Fatalf("stackSubmittedChanges = %#v", submitted)
	}
	if branch := resolveStackBranchName(map[string]any{"branch_name": " explicit "}); branch != "explicit" {
		t.Fatalf("explicit branch = %q", branch)
	}
	if branch := resolveStackBranchName(map[string]any{"change_id": "1234567890"}); branch != "smithers/12345678" {
		t.Fatalf("derived branch = %q", branch)
	}
	if branch := resolveStackBranchName(map[string]any{}); branch != "" {
		t.Fatalf("missing branch = %q", branch)
	}
	mapped := normalizeMappedStackChanges([]any{
		map[string]any{"change_id": "c", "position": float64(3)},
		map[string]any{"change_id": "a", "position": float64(1)},
		map[string]any{"change_id": " "},
	})
	if len(mapped) != 2 || stringValue(mapped[0]["change_id"]) != "a" {
		t.Fatalf("normalizeMappedStackChanges = %#v", mapped)
	}

	remaining := stackRemainingSummary(changes)
	if len(remaining) != 2 || objectValue(remaining[0])["pr_url"] != "https://example/pr/10" {
		t.Fatalf("stackRemainingSummary = %#v", remaining)
	}
	landed := stackLandedSummary(stackLandChange{Branch: "smithers/a", ChangeID: "aaaa", PRNumber: 3, PRURL: "url"})
	if landed["push_target"] != "origin/smithers/a" || landed["pr_number"] != 3 {
		t.Fatalf("stackLandedSummary = %#v", landed)
	}
	if pullRequestURL("alice", "demo", 0) != "" || pullRequestURL("alice", "demo", 2) != "https://github.com/alice/demo/pull/2" {
		t.Fatal("pullRequestURL returned unexpected value")
	}
	if defaultString("", "fallback") != "fallback" || defaultString("value", "fallback") != "value" {
		t.Fatal("defaultString returned unexpected value")
	}
}

func TestCommandsStack_Cov_LandabilitySelectionAndStatusAggregation(t *testing.T) {
	landable := []stackLandChange{
		{ChangeID: "abc111", PRNumber: 1, ReviewStatus: "approved", CIStatus: "passing", PRState: "open"},
		{ChangeID: "def222", PRNumber: 2, ReviewStatus: "approved", CIStatus: "passing", PRState: "open"},
	}
	if reason := stackLandabilityError(landable[0]); reason != "" {
		t.Fatalf("landable change reported reason: %s", reason)
	}
	for _, tc := range []struct {
		change stackLandChange
		want   string
	}{
		{stackLandChange{ChangeID: "abc", PRNumber: 1, ReviewStatus: "pending", CIStatus: "passing", PRState: "open"}, "pending review"},
		{stackLandChange{ChangeID: "abc", PRNumber: 1, ReviewStatus: "changes_requested", CIStatus: "passing", PRState: "open"}, "changes requested"},
		{stackLandChange{ChangeID: "abc", PRNumber: 1, ReviewStatus: "approved", CIStatus: "failing", PRState: "open"}, "CI is failing"},
		{stackLandChange{ChangeID: "abc", PRNumber: 1, ReviewStatus: "approved", CIStatus: "passing", PRState: "closed"}, "PR is closed"},
	} {
		if got := stackLandabilityError(tc.change); !strings.Contains(got, tc.want) {
			t.Fatalf("stackLandabilityError() = %q, want contains %q", got, tc.want)
		}
	}

	count, err := selectStackLandCount(landable, false, "", false)
	if err != nil || count != 1 {
		t.Fatalf("default select count = %d, %v", count, err)
	}
	count, err = selectStackLandCount(landable, true, "", false)
	if err != nil || count != 2 {
		t.Fatalf("--all select count = %d, %v", count, err)
	}
	count, err = selectStackLandCount(landable, false, "def", true)
	if err != nil || count != 2 {
		t.Fatalf("requested select count = %d, %v", count, err)
	}
	_, err = selectStackLandCount([]stackLandChange{}, false, "", false)
	if err == nil || !strings.Contains(err.Error(), "no changes") {
		t.Fatalf("expected empty stack error, got %v", err)
	}
	_, err = selectStackLandCount([]stackLandChange{{ChangeID: "abc1", PRNumber: 1}, {ChangeID: "abc2", PRNumber: 2}}, false, "abc", true)
	if err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("expected ambiguous prefix error, got %v", err)
	}
	_, err = selectStackLandCount(landable, false, "missing", true)
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expected missing requested change error, got %v", err)
	}

	if normalizeReviewStatus("changes requested") != "changes_requested" || normalizeReviewStatus("ignored") != "pending" {
		t.Fatal("normalizeReviewStatus returned unexpected values")
	}
	if normalizeCIStatus("success") != "passing" || normalizeCIStatus("cancelled") != "failing" || normalizeCIStatus("waiting") != "pending" {
		t.Fatal("normalizeCIStatus returned unexpected values")
	}
	if normalizePRState(" Open ") != "open" {
		t.Fatal("normalizePRState did not trim and lowercase")
	}
	for _, tc := range []struct {
		run  map[string]any
		want string
	}{
		{map[string]any{"status": "queued"}, "pending"},
		{map[string]any{"status": "completed", "conclusion": "success"}, "success"},
		{map[string]any{"status": "completed", "conclusion": "timed_out"}, "failure"},
		{map[string]any{"status": "completed", "conclusion": "weird"}, "pending"},
	} {
		if got := checkRunStatus(tc.run); got != tc.want {
			t.Fatalf("checkRunStatus(%#v) = %q, want %q", tc.run, got, tc.want)
		}
	}
	if aggregateCheckStatus(nil) != "pending" || aggregateCheckStatus([]string{"success", "pending"}) != "pending" || aggregateCheckStatus([]string{"success", "failure"}) != "failing" || aggregateCheckStatus([]string{"success"}) != "passing" {
		t.Fatal("aggregateCheckStatus returned unexpected value")
	}
	reviewStatus, reviewers := aggregateReviewStatus([]any{
		map[string]any{"user": map[string]any{"login": "Bob"}, "state": "APPROVED"},
		map[string]any{"user": map[string]any{"login": "alice"}, "state": "CHANGES_REQUESTED"},
		map[string]any{"user": map[string]any{"login": ""}, "state": "APPROVED"},
	})
	if reviewStatus != "changes_requested" || len(reviewers) != 2 || objectValue(reviewers[0])["login"] != "alice" {
		t.Fatalf("aggregateReviewStatus = %q, %#v", reviewStatus, reviewers)
	}
}

func TestCommandsStack_Cov_GitHubStateMutations(t *testing.T) {
	step := 0
	commandsStackCovGitHubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /repos/alice/demo/pulls/1":
			fmt.Fprint(w, `{"state":"open"}`)
		case "PATCH /repos/alice/demo/pulls/1":
			fmt.Fprint(w, `{"state":"closed"}`)
		case "GET /repos/alice/demo/pulls/2":
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		case "GET /repos/alice/demo/pulls/3":
			fmt.Fprint(w, `{"state":"closed"}`)
		case "DELETE /repos/alice/demo/git/refs/heads/feature":
			w.WriteHeader(http.StatusUnprocessableEntity)
			fmt.Fprint(w, `{"message":"Reference does not exist"}`)
		case "DELETE /repos/alice/demo/git/refs/heads/obsolete":
			w.WriteHeader(http.StatusNoContent)
		case "PUT /repos/alice/demo/pulls/5/merge":
			step++
			if step == 1 {
				w.WriteHeader(http.StatusMethodNotAllowed)
				fmt.Fprint(w, `{"message":"merge disabled"}`)
				return
			}
			fmt.Fprint(w, `{"merged":true}`)
		case "PUT /repos/alice/demo/pulls/6/merge":
			w.WriteHeader(http.StatusConflict)
			fmt.Fprint(w, `{"message":"branch is out of date"}`)
		default:
			t.Fatalf("unexpected GitHub mutation request: %s %s", r.Method, r.URL.Path)
		}
	})

	status, err := closePullRequestIfOpen("alice", "demo", 1)
	if err != nil || status != "closed" {
		t.Fatalf("closePullRequestIfOpen open = %q, %v", status, err)
	}
	status, err = closePullRequestIfOpen("alice", "demo", 2)
	if err != nil || status != "missing" {
		t.Fatalf("closePullRequestIfOpen missing = %q, %v", status, err)
	}
	status, err = closePullRequestIfOpen("alice", "demo", 3)
	if err != nil || status != "already_closed" {
		t.Fatalf("closePullRequestIfOpen closed = %q, %v", status, err)
	}
	status, err = deleteRemoteBranchIfExists("alice", "demo", "feature")
	if err != nil || status != "missing" {
		t.Fatalf("deleteRemoteBranchIfExists missing = %q, %v", status, err)
	}
	status, err = deleteRemoteBranchIfExists("alice", "demo", "obsolete")
	if err != nil || status != "deleted" {
		t.Fatalf("deleteRemoteBranchIfExists deleted = %q, %v", status, err)
	}
	if err := mergePullRequest("alice", "demo", 5); err != nil {
		t.Fatalf("mergePullRequest should fall back to squash: %v", err)
	}
	err = mergePullRequest("alice", "demo", 6)
	if err == nil || !strings.Contains(err.Error(), "branch is out of date") {
		t.Fatalf("expected merge conflict detail, got %v", err)
	}
}

func TestCommandsStack_Cov_StatusAndEnrichment(t *testing.T) {
	change := composeStatusChange("alice", "demo", LocalStackChange{
		ChangeID: "abc123", Description: "Title\n\nBody",
	}, map[string]any{"pr_number": float64(7), "ci_status": "success", "review_status": "approved"})
	if change["description"] != "Title" || change["pr_url"] != "https://github.com/alice/demo/pull/7" || change["pr_state"] != "open" {
		t.Fatalf("composeStatusChange local = %#v", change)
	}
	mappedOnly := composeStatusChange("alice", "demo", LocalStackChange{}, map[string]any{"change_id": "missing"})
	if mappedOnly["description"] != "missing" || mappedOnly["pr_number"] != nil {
		t.Fatalf("composeStatusChange mapped only = %#v", mappedOnly)
	}

	inactive, err := buildStackStatus("alice", "demo", "main", nil)
	if err != nil {
		t.Fatalf("buildStackStatus inactive returned error: %v", err)
	}
	if inactive["state"] != "inactive" || inactive["stack_id"] != nil {
		t.Fatalf("inactive status = %#v", inactive)
	}
	t.Chdir(t.TempDir())
	t.Setenv("GITHUB_TOKEN", "")
	active, err := buildStackStatus("alice", "demo", "main", map[string]any{
		"id":         22,
		"state":      "active",
		"target_ref": "main",
		"changes": []any{
			map[string]any{"change_id": "mapped", "position": 1, "pr_number": 4, "review_status": "approved", "ci_status": "passing"},
		},
	})
	if err != nil {
		t.Fatalf("buildStackStatus active returned error: %v", err)
	}
	if len(arrayValue(active["changes"])) != 1 || active["stack_id"] != 22 {
		t.Fatalf("active status = %#v", active)
	}

	strict := map[string]any{"pr_number": 3, "ci_status": "passing", "review_status": "approved"}
	strict, err = enrichStatusChangeWithGitHub("alice", "demo", strict, true)
	if err != nil {
		t.Fatalf("strict enrichment without token returned error: %v", err)
	}
	if strict["ci_status"] != "pending" || strict["review_status"] != "pending" || strict["mergeable"] != false {
		t.Fatalf("strict no-token enrichment = %#v", strict)
	}

	commandsStackCovGitHubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/alice/demo/pulls/8":
			fmt.Fprint(w, `{"state":"open","html_url":"https://github.local/pr/8","mergeable":true,"head":{"sha":"sha-8"}}`)
		case "/repos/alice/demo/commits/sha-8/check-runs":
			fmt.Fprint(w, `{"check_runs":[{"name":"unit","status":"completed","conclusion":"success"},{"name":"","status":"queued"}]}`)
		case "/repos/alice/demo/pulls/8/reviews":
			fmt.Fprint(w, `[{"user":{"login":"zoe"},"state":"APPROVED"}]`)
		default:
			t.Fatalf("unexpected enrichment request: %s", r.URL.Path)
		}
	})
	enriched, err := enrichStatusChangeWithGitHub("alice", "demo", map[string]any{"pr_number": 8}, true)
	if err != nil {
		t.Fatalf("enrichStatusChangeWithGitHub returned error: %v", err)
	}
	if enriched["mergeable"] != true || enriched["ci_status"] != "pending" || enriched["review_status"] != "approved" {
		t.Fatalf("enriched status = %#v", enriched)
	}
	if len(arrayValue(enriched["checks"])) != 2 {
		t.Fatalf("checks were not populated: %#v", enriched["checks"])
	}
}

func TestCommandsStack_Cov_LandChangeBuildAndWorkflowErrorPaths(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "")
	if _, err := buildStackLandChanges("alice", "demo", []map[string]any{{"change_id": "abc", "pr_number": 1}}); err != nil {
		t.Fatalf("buildStackLandChanges should derive branch with no token: %v", err)
	}
	_, err := buildStackLandChanges("alice", "demo", []map[string]any{{"change_id": "abc"}})
	if err == nil || !strings.Contains(err.Error(), "missing pr_number") {
		t.Fatalf("expected missing pr_number error, got %v", err)
	}
	_, err = buildStackLandChanges("alice", "demo", []map[string]any{{"branch_name": " ", "change_id": " ", "pr_number": 1}})
	if err == nil || !strings.Contains(err.Error(), "Unable to resolve branch") {
		t.Fatalf("expected missing branch error, got %v", err)
	}

	commandsStackCovNoJj(t)
	if _, err := syncStack("alice", "demo", "main"); err == nil || !strings.Contains(err.Error(), "jj") {
		t.Fatalf("expected syncStack jj error, got %v", err)
	}
	if _, err := restackSubmitted("alice", "demo", "main", []submittedStackChange{{ChangeID: "abc", Branch: "smithers/abc"}}, nil); err == nil || !strings.Contains(err.Error(), "jj") {
		t.Fatalf("expected restackSubmitted jj error, got %v", err)
	}
	if _, err := restackRemainingAfterLanding("alice", "demo", "main", nil); err == nil || !strings.Contains(err.Error(), "jj") {
		t.Fatalf("expected restackRemainingAfterLanding jj error, got %v", err)
	}
}

func TestCommandsStack_Cov_SummaryFormattersAndIndicators(t *testing.T) {
	submitted := []submittedStackChange{{PRNumber: 1, Title: "One", Branch: "smithers/one", Status: "created"}}
	if got := formatStackSubmitSummary("alice", "demo", submitted); !strings.Contains(got, "Submitted stack (1 changes)") || !strings.Contains(got, "#1 One") {
		t.Fatalf("formatStackSubmitSummary = %q", got)
	}
	if got := formatStackUnsubmitSummary("alice", "demo", "main", map[string]any{"stack_deleted": false}); !strings.Contains(got, "No active stack") {
		t.Fatalf("formatStackUnsubmitSummary missing stack = %q", got)
	}
	if got := formatStackUnsubmitSummary("alice", "demo", "main", map[string]any{"stack_deleted": true}); !strings.Contains(got, "Unsubmitted stack") {
		t.Fatalf("formatStackUnsubmitSummary deleted = %q", got)
	}
	if got := formatStackSyncSummary("alice", "demo", "main", map[string]any{"stack_found": false}); !strings.Contains(got, "No active stack") {
		t.Fatalf("formatStackSyncSummary missing = %q", got)
	}
	syncSummary := formatStackSyncSummary("alice", "demo", "main", map[string]any{
		"stack_found": true,
		"merged":      []any{map[string]any{"pr_number": 1}},
		"remaining":   []any{map[string]any{"pr_number": 2}},
	})
	if !strings.Contains(syncSummary, "Merged PRs removed: #1") || !strings.Contains(syncSummary, "Remaining PRs: #2") {
		t.Fatalf("formatStackSyncSummary = %q", syncSummary)
	}
	landSummary := formatStackLandSummary("alice", "demo", "main", map[string]any{
		"stack_found": true, "stack_deleted": true, "landed": []any{map[string]any{"pr_number": 3}},
	})
	if !strings.Contains(landSummary, "PRs merged: #3") || !strings.Contains(landSummary, "Backend stack mapping removed") {
		t.Fatalf("formatStackLandSummary = %q", landSummary)
	}
	if stackPRList(nil) != "(none)" || stackPRList([]any{map[string]any{"pr_number": 4}, map[string]any{"name": "no pr"}}) != "#4" {
		t.Fatal("stackPRList returned unexpected value")
	}

	statusSummary := formatStackStatusSummary("alice", "demo", "main", map[string]any{
		"stack_id": 1,
		"target":   "main",
		"changes": []any{map[string]any{
			"change_id": "abcdef123", "description": "Change", "pr_number": 5,
			"pr_state": "closed", "review_status": "changes_requested", "ci_status": "failing",
		}},
	})
	if !strings.Contains(statusSummary, "abcdef12") || !strings.Contains(statusSummary, "Changes requested") || !strings.Contains(statusSummary, "CI failing") {
		t.Fatalf("formatStackStatusSummary = %q", statusSummary)
	}
	if got := formatStackStatusSummary("alice", "demo", "main", map[string]any{"stack_id": nil}); !strings.Contains(got, "No active stack") {
		t.Fatalf("formatStackStatusSummary inactive = %q", got)
	}
	if prStateIndicator("merged") == prStateIndicator("closed") || reviewIndicator("approved") == reviewIndicator("pending") || ciIndicator("passing") == ciIndicator("failing") {
		t.Fatal("status indicators did not distinguish states")
	}
	if formatReviewLabel("approved") != "Approved" || formatReviewLabel("changes_requested") != "Changes requested" || formatReviewLabel("pending") != "Pending review" {
		t.Fatal("formatReviewLabel returned unexpected value")
	}
	if formatCILabel("passing") != "CI passing" || formatCILabel("failing") != "CI failing" || formatCILabel("pending") != "CI pending" {
		t.Fatal("formatCILabel returned unexpected value")
	}
}

func TestCommandsStack_Cov_GitHubRepoPathParsing(t *testing.T) {
	owner, repo, ok := githubRepoFromAPIPath("/repos/alice/demo/pulls/1")
	if !ok || owner != "alice" || repo != "demo" {
		t.Fatalf("githubRepoFromAPIPath basic = %q, %q, %v", owner, repo, ok)
	}
	owner, repo, ok = githubRepoFromAPIPath("/repos/alice%20org/demo-repo/pulls")
	if !ok || owner != "alice org" || repo != "demo-repo" {
		t.Fatalf("githubRepoFromAPIPath escaped = %q, %q, %v", owner, repo, ok)
	}
	for _, path := range []string{"", "/user", "/repos//demo", "/repos/alice/%zz"} {
		if _, _, ok := githubRepoFromAPIPath(path); ok {
			t.Fatalf("expected %q to be rejected", path)
		}
	}
}
