//go:build linux

package smitherscli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func baseAgentIssueContext() map[string]any {
	return map[string]any{
		"collectedAt": "2026-03-12T00:00:00Z",
		"cwd":         "/tmp/repo",
		"repoRoot":    "/tmp/repo",
		"repoSlug":    "alice/demo",
		"repoSource":  "detected",
		"jjRemotes": map[string]any{
			"command":  "jj git remote list",
			"ok":       true,
			"output":   "origin git@ssh.smithers.sh:alice/demo.git",
			"exitCode": 0,
		},
		"jjStatus": map[string]any{
			"command":  "jj status",
			"ok":       true,
			"output":   "Working copy changes:\nA hello.txt",
			"exitCode": 0,
		},
		"auth": map[string]any{
			"loggedIn": false,
			"host":     "smithers.sh",
			"verified": false,
			"message":  "Not logged in to smithers.sh",
		},
		"remoteRepo": map[string]any{
			"checked": false,
			"message": "Skipped because Smithers auth is unavailable",
		},
		"warnings": []any{},
	}
}

func TestResolveAgentIssueTargetRepoRequiresConfig(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_AGENT_ISSUE_REPO", "")
	if _, err := resolveAgentIssueTargetRepo(""); err == nil || !strings.Contains(err.Error(), "SMITHERS_AGENT_ISSUE_REPO") {
		t.Fatalf("expected missing config error, got %v", err)
	}
}

func TestBuildAgentIssueBodyIncludesContext(t *testing.T) {
	body := buildAgentIssueBody(agentIssueParams{
		Title:            "Auth flow is confusing",
		Summary:          "The CLI did not explain how to recover.",
		ExpectedBehavior: "The helper should point the user to browser login.",
		ActualBehavior:   "The helper replied without any Smithers-specific guidance.",
	}, baseAgentIssueContext())
	for _, want := range []string{
		"## Summary",
		"The CLI did not explain how to recover.",
		"- detected Smithers repo: alice/demo",
		"## Expected Behavior",
		"## Actual Behavior",
		"## `jj status`",
		"Working copy changes:",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("body missing %q:\n%s", want, body)
		}
	}
}

func TestCreateAgentIssuePostsToConfiguredRepo(t *testing.T) {
	root := t.TempDir()
	configHome := filepath.Join(root, "cfg")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/repos/smithers/platform/issues" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "token smithers_testtoken" {
			t.Fatalf("Authorization = %q", got)
		}
		var body struct {
			Title string `json:"title"`
			Body  string `json:"body"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Title != "Auth flow is confusing" {
			t.Fatalf("title = %q", body.Title)
		}
		if !strings.Contains(body.Body, "- detected Smithers repo: alice/demo") {
			t.Fatalf("body missing repo context:\n%s", body.Body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"number":42,"title":"Auth flow is confusing"}`))
	}))
	defer server.Close()

	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_TOKEN", "smithers_testtoken")
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+server.URL+"\nagent_issue_repo: smithers/platform\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	created, err := createAgentIssue(agentIssueParams{
		Title:            "Auth flow is confusing",
		Summary:          "The CLI did not explain how to recover.",
		ExpectedBehavior: "The helper should point the user to browser login.",
		ActualBehavior:   "The helper replied without any Smithers-specific guidance.",
	}, baseAgentIssueContext())
	if err != nil {
		t.Fatal(err)
	}
	if number := objectValue(created)["number"]; number == nil {
		t.Fatalf("created issue missing number: %#v", created)
	}
}
