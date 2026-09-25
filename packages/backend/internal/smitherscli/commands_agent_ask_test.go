package smitherscli

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	incur "github.com/smithersai/incur"
)

// agentAskAPI records every request the CLI sends to the Smithers API and
// serves a tiny docs bundle so `agent ask` can answer offline.
func agentAskAPI(t *testing.T) (*httptest.Server, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path)
		mu.Unlock()
		switch {
		case r.URL.Path == "/llms-full.txt":
			fmt.Fprint(w, "# Smithers Docs\n\n## Login\n\nUse smithers auth login for browser authentication.\n")
		case r.Method == http.MethodGet && r.URL.Path == "/api/user":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"login":"alice"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"full_name":"alice/demo"}`)
		case strings.Contains(r.URL.Path, "/workspaces"):
			w.Header().Set("Content-Type", "application/json")
			if r.Method == http.MethodPost {
				fmt.Fprint(w, `{"id":"ws_created"}`)
				return
			}
			fmt.Fprint(w, `[]`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), seen...)
	}
}

// `agent ask` is a local docs lookup. It must never provision cloud
// workspace capacity, so there is no --sandbox flag to request one.
func TestAgentAsk_SandboxFlagNeverTouchesWorkspaces(t *testing.T) {
	repoRoot := t.TempDir()
	server, requests := agentAskAPI(t)
	commandsAgentCovSetConfig(t, server.URL, "commands_agent_ask_token")
	t.Setenv("SMITHERS_AGENT_DOCS_URL", server.URL+"/llms-full.txt")
	commandsAgentCovInstallFakeJj(t, repoRoot, "origin git@ssh.example.test:alice/demo.git", "clean")
	commandsAgentCovChdir(t, repoRoot)

	var stdout bytes.Buffer
	err := agentCommand().ServeWithOptions(
		[]string{"ask", "--repo", "alice/demo", "--sandbox", "browser login"},
		incur.ServeOptions{Stdout: &stdout},
	)
	for _, request := range requests() {
		if strings.Contains(request, "/workspaces") {
			t.Fatalf("agent ask --sandbox sent workspace request %q; all requests: %v", request, requests())
		}
	}
	if err == nil || !strings.Contains(err.Error(), "Unknown flag: --sandbox") {
		t.Fatalf("agent ask --sandbox error = %v; output:\n%s", err, stdout.String())
	}
	if help := commandsAgentCovServe(t, agentCommand(), []string{"ask", "--help"}); strings.Contains(help, "--sandbox") {
		t.Fatalf("agent ask help still advertises --sandbox:\n%s", help)
	}
}

// Answering from the docs index needs neither jj nor a repository.
func TestAgentAsk_AnswersWithoutJj(t *testing.T) {
	server, _ := agentAskAPI(t)
	commandsAgentCovSetConfig(t, server.URL, "")
	t.Setenv("SMITHERS_AGENT_DOCS_URL", server.URL+"/llms-full.txt")
	t.Setenv("PATH", t.TempDir())
	commandsAgentCovChdir(t, t.TempDir())

	out := commandsAgentCovServe(t, agentCommand(), []string{"ask", "browser login"})
	if !strings.Contains(out, "smithers auth login") {
		t.Fatalf("agent ask without jj did not answer from docs:\n%s", out)
	}
}
