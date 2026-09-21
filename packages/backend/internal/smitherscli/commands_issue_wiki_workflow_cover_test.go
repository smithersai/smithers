package smitherscli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func commandsIssueWikiWorkflowCovSetConfig(t *testing.T, apiURL string) {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_TOKEN", "commands_issue_wiki_workflow_cov_token")
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(t.TempDir(), "auth.json"))
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commandsIssueWikiWorkflowCovServe(t *testing.T, cli *incur.Cli, argv []string) string {
	t.Helper()
	var stdout bytes.Buffer
	if err := cli.ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("ServeWithOptions(%v) returned error: %v\n%s", argv, err, stdout.String())
	}
	return stdout.String()
}

func commandsIssueWikiWorkflowCovCaptureStderr(t *testing.T, fn func()) string {
	t.Helper()
	oldStderr := os.Stderr
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = writer
	defer func() {
		os.Stderr = oldStderr
		_ = reader.Close()
	}()
	fn()
	_ = writer.Close()
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, reader); err != nil {
		t.Fatal(err)
	}
	return buf.String()
}

func TestCommandsIssueWikiWorkflow_Cov_IssueAndWikiCommands(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.RequestURI())
		if got := r.Header.Get("Authorization"); got != "token commands_issue_wiki_workflow_cov_token" {
			t.Fatalf("Authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/issues/7/comments":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("invalid comment body: %v", err)
			}
			if strings.TrimSpace(stringValue(body["body"])) == "" {
				t.Fatalf("empty comment body: %#v", body)
			}
			fmt.Fprint(w, `{"id":1,"body":"comment"}`)
		case r.Method == http.MethodPatch && r.URL.Path == "/api/repos/alice/demo/issues/7":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("invalid issue patch body: %v", err)
			}
			title := "Crash on launch"
			state := stringValue(body["state"])
			if body["title"] != nil {
				title = stringValue(body["title"])
			}
			if state == "" {
				state = "open"
			}
			fmt.Fprintf(w, `{"number":7,"title":%q,"state":%q}`, title, state)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/issues/7/reactions":
			fmt.Fprint(w, `{"content":"heart"}`)
		case r.Method == http.MethodPut && r.URL.Path == "/api/repos/alice/demo/issues/7/pin":
			fmt.Fprint(w, `{"number":7,"pinned":true}`)
		case r.Method == http.MethodPut && r.URL.Path == "/api/repos/alice/demo/issues/7/lock":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("invalid lock body: %v", err)
			}
			if body["reason"] != "resolved" {
				t.Fatalf("lock body = %#v", body)
			}
			fmt.Fprint(w, `{"number":7,"locked":true}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/issues/7/dependencies":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("invalid dependency body: %v", err)
			}
			if intValue(body["blocks"], 0) != 8 {
				t.Fatalf("dependency body = %#v", body)
			}
			fmt.Fprint(w, `{"blocks":8}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/issues":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("invalid issue body: %v", err)
			}
			if body["title"] != "Crash on launch" || len(arrayValue(body["assignees"])) != 1 {
				t.Fatalf("issue create body = %#v", body)
			}
			fmt.Fprint(w, `{"number":7,"title":"Crash on launch","state":"open","author":{"login":"alice"}}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/issues":
			if r.URL.Query().Get("cursor") == "" {
				w.Header().Set("Link", `</api/repos/alice/demo/issues?cursor=n2>; rel="next"`)
				fmt.Fprint(w, `[{"number":7,"title":"Crash on launch","state":"open","author":{"login":"alice"}}]`)
				return
			}
			fmt.Fprint(w, `[{"number":8,"title":"Second","state":"closed","author":{}}]`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/issues/7":
			fmt.Fprint(w, `{"number":7,"title":"Crash on launch","state":"open","body":"body","author":{"login":"alice"},"assignees":[{"login":"bob"}]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/wiki":
			if r.URL.Query().Get("q") != "" {
				t.Fatalf("wiki list should not include blank q: %s", r.URL.RawQuery)
			}
			fmt.Fprint(w, `[{"title":"Home","slug":"home","author":{"login":"writer"},"updated_at":"today"}]`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/wiki/search":
			if _, ok := r.URL.Query()["q"]; !ok {
				t.Fatalf("wiki search missing q in query: %s", r.URL.RawQuery)
			}
			fmt.Fprint(w, `[{"title":"Docs","slug":"docs","author":{},"updated_at":"today"}]`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/wiki":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("invalid wiki create body: %v", err)
			}
			if body["title"] != "Home" || body["slug"] != nil {
				t.Fatalf("wiki create body = %#v", body)
			}
			fmt.Fprint(w, `{"title":"Home","slug":"home"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/wiki/home":
			fmt.Fprint(w, `{"title":"Home","slug":"home","body":"Welcome","author":{"login":"writer"},"updated_at":"today"}`)
		case r.Method == http.MethodPatch && r.URL.Path == "/api/repos/alice/demo/wiki/home":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("invalid wiki patch body: %v", err)
			}
			if body["title"] != "Updated" || body["body"] != "New body" {
				t.Fatalf("wiki patch body = %#v", body)
			}
			fmt.Fprint(w, `{"title":"Updated","slug":"home"}`)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/repos/alice/demo/wiki/home":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/wiki/home/revisions":
			fmt.Fprint(w, `[{"id":12,"title":"Home","author":{},"updated_at":"today"}]`)
		default:
			t.Fatalf("unexpected issue/wiki request: %s %s", r.Method, r.URL.RequestURI())
		}
	}))
	defer server.Close()
	commandsIssueWikiWorkflowCovSetConfig(t, server.URL)

	created := commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"create", "--repo", "alice/demo", "--title", "Crash on launch", "--body", "details", "--assignee", "bob"})
	if !strings.Contains(created, "Created issue #7") {
		t.Fatalf("issue create output = %q", created)
	}
	var stdout bytes.Buffer
	if err := issueCommand().ServeWithOptions([]string{"create", "--repo", "alice/demo"}, incur.ServeOptions{Stdout: &stdout}); err == nil || !strings.Contains(err.Error(), "issue title is required") {
		t.Fatalf("missing issue title error = %v stdout=%s", err, stdout.String())
	}
	listed := commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"list", "--repo", "alice/demo", "--limit", "2"})
	if !strings.Contains(listed, "More results available") {
		t.Fatalf("issue list output missing pagination hint:\n%s", listed)
	}
	allIssues := commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"list", "--repo", "alice/demo", "--all", "--json"})
	if !strings.Contains(allIssues, `"number": 8`) {
		t.Fatalf("issue list --all output = %s", allIssues)
	}
	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"view", "7", "--repo", "alice/demo", "--json"})
	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"close", "7", "--repo", "alice/demo", "--comment", "done"})
	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"reopen", "7", "--repo", "alice/demo"})
	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"edit", "7", "--repo", "alice/demo", "--title", "Updated", "--body", "new", "--assignee", "bob", "--label", "bug"})
	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"comment", "7", "--repo", "alice/demo", "--body", "note"})
	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"lock", "7", "--repo", "alice/demo", "--reason", "resolved"})

	if _, err := parseIssueNumber("0", "issue number"); err == nil || !strings.Contains(err.Error(), "invalid issue number") {
		t.Fatalf("parseIssueNumber zero error = %v", err)
	}
	if _, err := parseIssueNumber("abc", "issue number"); err == nil || !strings.Contains(err.Error(), "invalid issue number") {
		t.Fatalf("parseIssueNumber text error = %v", err)
	}
	calledIssueHandler := false
	issueDef := issueNumberCommand("Direct issue", func(owner, repo string, number int, ctx *incur.CommandContext) (any, error) {
		calledIssueHandler = true
		if owner != "alice" || repo != "demo" || number != 7 {
			t.Fatalf("issue handler args = %s/%s #%d", owner, repo, number)
		}
		return "ok", nil
	})
	if result, err := issueDef.Handler(&incur.CommandContext{Args: map[string]any{"number": "7"}, Options: map[string]any{"repo": "alice/demo"}}); err != nil || result != "ok" || !calledIssueHandler {
		t.Fatalf("issueNumberCommand handler = (%#v, %v), called=%t", result, err, calledIssueHandler)
	}
	if required := issueNumberCommandWithOptions("Add a comment to an issue", map[string]*incur.JSONSchema{"body": stringSchema("body")}, nil).OptionsSchema.Required; len(required) != 1 || required[0] != "body" {
		t.Fatalf("comment required options = %#v", required)
	}
	if required := issueNumberCommandWithOptions("Link", map[string]*incur.JSONSchema{"blocks": stringSchema("blocks")}, nil).OptionsSchema.Required; len(required) != 1 || required[0] != "blocks" {
		t.Fatalf("blocks required options = %#v", required)
	}

	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"list", "--repo", "alice/demo"})
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"search", "--repo", "alice/demo", "--query", "docs", "--json"})
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"create", "--repo", "alice/demo", "--title", "Home", "--body", "Welcome"})
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"view", "home", "--repo", "alice/demo"})
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"edit", "home", "--repo", "alice/demo", "--title", "Updated", "--body", "New body"})
	deleted := commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"delete", "home", "--repo", "alice/demo"})
	if !strings.Contains(deleted, "Deleted wiki page home") {
		t.Fatalf("wiki delete output = %q", deleted)
	}
	commandsIssueWikiWorkflowCovServe(t, wikiCommand(), []string{"revisions", "home", "--repo", "alice/demo", "--page", "1", "--limit", "10"})

	pages, err := wikiListRequest(&incur.CommandContext{Options: map[string]any{"repo": "alice/demo", "query": " ", "page": 1, "limit": 30}}, "/wiki/search", false)
	if err != nil || len(arrayValue(pages)) == 0 {
		t.Fatalf("wikiListRequest optional false = (%#v, %v)", pages, err)
	}
	calledSlugHandler := false
	slugDef := wikiSlugCommand("Direct wiki", func(owner, repo, slug string, ctx *incur.CommandContext) (any, error) {
		calledSlugHandler = true
		if owner != "alice" || repo != "demo" || slug != "home" {
			t.Fatalf("wiki handler args = %s/%s %s", owner, repo, slug)
		}
		return "ok", nil
	})
	if result, err := slugDef.Handler(&incur.CommandContext{Args: map[string]any{"slug": "home"}, Options: map[string]any{"repo": "alice/demo"}}); err != nil || result != "ok" || !calledSlugHandler {
		t.Fatalf("wikiSlugCommand handler = (%#v, %v), called=%t", result, err, calledSlugHandler)
	}
	if wikiSlugCommandWithOptions("Edit", map[string]*incur.JSONSchema{"title": stringSchema("title")}, func(string, string, string, *incur.CommandContext) (any, error) { return nil, nil }).OptionsSchema.Properties["title"] == nil {
		t.Fatal("wikiSlugCommandWithOptions did not include extra option")
	}
	if len(seen) < 15 {
		t.Fatalf("expected many issue/wiki requests, saw %v", seen)
	}
}

func TestCommandsIssueWikiWorkflow_Cov_WorkflowCommandsAndEvents(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "token commands_issue_wiki_workflow_cov_token" {
			t.Fatalf("Authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workflows":
			fmt.Fprint(w, `{"workflows":[{"id":123,"name":"Build"}]}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/workflows/123/dispatches":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("invalid dispatch body: %v", err)
			}
			if body["ref"] != "dev" && body["ref"] != "main" {
				t.Fatalf("dispatch ref = %#v", body)
			}
			fmt.Fprint(w, `{"runs":[{"workflow_run_id":99,"status":"queued"}]}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/workflows/124/dispatches":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/runs":
			fmt.Fprint(w, `[{"id":42,"status":"completed"}]`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/runs/42":
			fmt.Fprint(w, `{"id":42,"status":"completed"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/runs/43":
			fmt.Fprint(w, `{"id":43,"status":"running"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/runs/42/rerun":
			fmt.Fprint(w, `{"id":42,"status":"queued"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/runs/42/cancel":
			fmt.Fprint(w, `{"id":42,"status":"cancelled"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/runs/43/logs":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "event: log\nid: ev1\ndata: {\"step\":\"build\",\"content\":\"hello\"}\n\n")
			fmt.Fprint(w, "event: status\ndata: {\"status\":\"running\",\"step\":\"test\"}\n\n")
			fmt.Fprint(w, "event: done\ndata: {\"status\":\"completed\"}\n\n")
		default:
			t.Fatalf("unexpected workflow request: %s %s", r.Method, r.URL.RequestURI())
		}
	}))
	defer server.Close()
	commandsIssueWikiWorkflowCovSetConfig(t, server.URL)

	commandsIssueWikiWorkflowCovServe(t, workflowCommand(), []string{"list", "--repo", "alice/demo", "--json"})
	dispatchOut := commandsIssueWikiWorkflowCovCaptureStderr(t, func() {
		commandsIssueWikiWorkflowCovServe(t, workflowCommand(), []string{"dispatch", "123", "--repo", "alice/demo", "--ref", "dev", "--input", "env=prod", "--input", "empty=", "--json"})
	})
	if !strings.Contains(dispatchOut, "Dispatched run #99") {
		t.Fatalf("dispatch stderr = %q", dispatchOut)
	}
	commandsIssueWikiWorkflowCovServe(t, workflowCommand(), []string{"run", "build", "--repo", "alice/demo", "--ref", "main", "--json"})
	var stdout bytes.Buffer
	err := workflowCommand().ServeWithOptions([]string{"run", "missing", "--repo", "alice/demo", "--json"}, incur.ServeOptions{Stdout: &stdout})
	if err == nil || !strings.Contains(err.Error(), "Workflow missing not found") {
		t.Fatalf("missing workflow error = %v stdout=%s", err, stdout.String())
	}

	if opts := workflowDispatchOptions(); opts.Properties["input"] == nil || opts.Properties["ref"].Default != "main" {
		t.Fatalf("workflowDispatchOptions = %#v", opts.Properties)
	}
	result, err := workflowDispatchCommand("Direct dispatch").Handler(&incur.CommandContext{Args: map[string]any{"id": 123}, Options: map[string]any{"repo": "alice/demo", "ref": "dev", "input": []any{"key=value"}}})
	if err != nil || firstWorkflowRun(result) == nil {
		t.Fatalf("workflowDispatchCommand handler = (%#v, %v)", result, err)
	}
	nilResult, err := dispatchWorkflow("alice", "demo", 124, &incur.CommandContext{Options: map[string]any{"ref": "main"}})
	if err != nil || objectValue(nilResult)["status"] != "dispatched" {
		t.Fatalf("dispatchWorkflow nil result = (%#v, %v)", nilResult, err)
	}
	inputs := parseInputFlags([]string{"one=1", "novalue", " =skip", "two=two=2"})
	if inputs["one"] != "1" || inputs["two"] != "two=2" || len(inputs) != 2 {
		t.Fatalf("parseInputFlags = %#v", inputs)
	}
	if firstWorkflowRun(map[string]any{"runs": []any{"bad", map[string]any{"workflow_run_id": 1}}})["workflow_run_id"] == nil {
		t.Fatal("firstWorkflowRun did not skip bad records")
	}
	if firstWorkflowRun(map[string]any{}) != nil {
		t.Fatal("firstWorkflowRun should return nil without runs")
	}

	commandsIssueWikiWorkflowCovServe(t, workflowRunCommand(), []string{"list", "--repo", "alice/demo", "--json"})
	commandsIssueWikiWorkflowCovServe(t, workflowRunCommand(), []string{"view", "42", "--repo", "alice/demo", "--json"})
	commandsIssueWikiWorkflowCovServe(t, workflowRunCommand(), []string{"rerun", "42", "--repo", "alice/demo", "--json"})
	commandsIssueWikiWorkflowCovServe(t, workflowRunCommand(), []string{"cancel", "42", "--repo", "alice/demo", "--json"})
	logOutput := commandsIssueWikiWorkflowCovCaptureStderr(t, func() {
		commandsIssueWikiWorkflowCovServe(t, workflowRunCommand(), []string{"logs", "43", "--repo", "alice/demo", "--json"})
	})
	if !strings.Contains(logOutput, "[step build] hello") || !strings.Contains(logOutput, "Run completed: completed") {
		t.Fatalf("workflow logs stderr = %q", logOutput)
	}
	requestResult, err := workflowRunRequestCommand("Direct view", http.MethodGet, "").Handler(&incur.CommandContext{Args: map[string]any{"id": 42}, Options: map[string]any{"repo": "alice/demo"}})
	if err != nil || intValue(objectValue(requestResult)["id"], 0) != 42 {
		t.Fatalf("workflowRunRequestCommand handler = (%#v, %v)", requestResult, err)
	}
	watchResult, err := workflowRunWatchCommand("Direct watch").Handler(&incur.CommandContext{Args: map[string]any{"id": 42}, Options: map[string]any{"repo": "alice/demo"}})
	if err != nil || objectValue(watchResult)["status"] != "completed" {
		t.Fatalf("workflowRunWatchCommand completed = (%#v, %v)", watchResult, err)
	}
	activeWatch, err := watchWorkflowRun("alice", "demo", 43)
	if err != nil {
		t.Fatalf("watchWorkflowRun active returned error: %v", err)
	}
	activeEvents, ok := objectValue(activeWatch)["events"].([]map[string]any)
	if !ok || len(activeEvents) != 3 {
		t.Fatalf("watchWorkflowRun events = %#v", activeWatch)
	}
	events, err := streamWorkflowRunEvents("alice", "demo", 43)
	if err != nil || len(events) != 3 || events[0]["id"] != "ev1" {
		t.Fatalf("streamWorkflowRunEvents = (%#v, %v)", events, err)
	}
	if parsed := objectValue(parseSSEData(`{"ok":true}`)); parsed["ok"] != true {
		t.Fatalf("parseSSEData JSON = %#v", parsed)
	}
	if parsed := parseSSEData(`not-json`); parsed != "not-json" {
		t.Fatalf("parseSSEData raw = %#v", parsed)
	}

	eventOutput := commandsIssueWikiWorkflowCovCaptureStderr(t, func() {
		writeWorkflowEvent("log", map[string]any{"step": "1", "content": "hello"}, "raw")
		writeWorkflowEvent("log", map[string]any{}, "raw fallback")
		writeWorkflowEvent("status", map[string]any{"step": "2"}, "raw")
		writeWorkflowEvent("done", map[string]any{}, "raw")
		writeWorkflowEvent("custom", "plain", "raw custom")
	})
	for _, want := range []string{"[step 1] hello", "raw fallback", "Status: unknown (step 2)", "Run completed: unknown", "raw custom"} {
		if !strings.Contains(eventOutput, want) {
			t.Fatalf("writeWorkflowEvent output missing %q:\n%s", want, eventOutput)
		}
	}
}
