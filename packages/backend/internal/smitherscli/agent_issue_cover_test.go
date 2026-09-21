package smitherscli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func agentIssueCovSetConfig(t *testing.T, apiURL, body string) {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(t.TempDir(), "auth.json"))
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	content := "api_url: " + apiURL + "\n" + body
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func agentIssueCovContext() map[string]any {
	return map[string]any{
		"cwd":      "/work/demo",
		"repoRoot": "/work/demo",
		"repoSlug": "alice/demo",
		"auth": map[string]any{
			"loggedIn": true,
			"host":     "smithers.test",
		},
		"backend": map[string]any{
			"backend": "workspace",
		},
		"remoteRepo": map[string]any{
			"checked":   true,
			"available": false,
			"status":    "404",
		},
		"jjStatus": map[string]any{
			"output": "Working copy changes:\nM README.md",
		},
		"jjRemotes": map[string]any{
			"output": "origin git@ssh.smithers.sh:alice/demo.git",
		},
	}
}

func TestAgentIssue_Cov_ResolveTargetRepoBranches(t *testing.T) {
	agentIssueCovSetConfig(t, "https://api.example.test", "agent_issue_repo: smithers/platform\n")
	t.Setenv("SMITHERS_AGENT_ISSUE_REPO", "")
	if got, err := resolveAgentIssueTargetRepo("  explicit/repo  "); err != nil || got != "explicit/repo" {
		t.Fatalf("explicit repo = (%q, %v)", got, err)
	}
	if got, err := resolveAgentIssueTargetRepo(""); err != nil || got != "smithers/platform" {
		t.Fatalf("configured repo = (%q, %v)", got, err)
	}

	agentIssueCovSetConfig(t, "https://api.example.test", "")
	t.Setenv("SMITHERS_AGENT_ISSUE_REPO", "")
	if _, err := resolveAgentIssueTargetRepo(""); err == nil || !strings.Contains(err.Error(), "SMITHERS_AGENT_ISSUE_REPO") {
		t.Fatalf("missing repo error = %v", err)
	}
}

func TestAgentIssue_Cov_BodyFormattingBranches(t *testing.T) {
	body := buildAgentIssueBody(agentIssueParams{
		Summary:                "The assistant missed a recovery path.",
		ExpectedBehavior:       "Explain how to authenticate.",
		ActualBehavior:         "Returned generic guidance.",
		ReproSteps:             "1. Run smithers agent\n2. Ask for auth help",
		Workaround:             "Run smithers auth login manually.",
		WhyThisIsStillAProblem: "Users do not know the hidden command.",
	}, agentIssueCovContext())
	for _, want := range []string{
		"- auth: logged in to smithers.test",
		"- backend: workspace",
		"- Smithers repo availability: unavailable (404)",
		"## Expected Behavior",
		"## Repro Steps",
		"## Why This Is Still A Product/UX Issue",
		"## `jj git remote list`",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("issue body missing %q:\n%s", want, body)
		}
	}

	noAuth := buildAgentIssueBody(agentIssueParams{Summary: "No context"}, map[string]any{"cwd": "/tmp"})
	if !strings.Contains(noAuth, "- auth: not logged in") {
		t.Fatalf("nil auth branch missing:\n%s", noAuth)
	}
	if displayAgentNullable(nil) != "(not detected)" || displayAgentNullable("  ") != "(not detected)" || displayAgentNullable(" repo ") != "repo" {
		t.Fatal("displayAgentNullable returned unexpected values")
	}
}

func TestAgentIssue_Cov_CreateAgentIssueSuccessAndErrors(t *testing.T) {
	var postedTitle string
	var postedBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/repos/smithers/platform/issues" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "token agent_issue_cov_token" {
			t.Fatalf("Authorization = %q", got)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("invalid request body: %v", err)
		}
		postedTitle = stringValue(payload["title"])
		postedBody = stringValue(payload["body"])
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprint(w, `{"number":88,"title":"Filed"}`)
	}))
	defer server.Close()

	agentIssueCovSetConfig(t, server.URL, "")
	t.Setenv("SMITHERS_TOKEN", "agent_issue_cov_token")
	created, err := createAgentIssue(agentIssueParams{
		Title:   "  Filed  ",
		Summary: "A concise summary.",
		Repo:    "smithers/platform",
	}, agentIssueCovContext())
	if err != nil {
		t.Fatalf("createAgentIssue returned error: %v", err)
	}
	if intValue(objectValue(created)["number"], 0) != 88 {
		t.Fatalf("created issue = %#v", created)
	}
	if postedTitle != "Filed" || !strings.Contains(postedBody, "A concise summary.") {
		t.Fatalf("posted title/body = %q / %q", postedTitle, postedBody)
	}

	if _, err = createAgentIssue(agentIssueParams{Repo: "not-a-repo", Summary: "bad"}, agentIssueCovContext()); err == nil || !strings.Contains(err.Error(), "Invalid Smithers issue destination") {
		t.Fatalf("invalid target repo error = %v", err)
	}
}
