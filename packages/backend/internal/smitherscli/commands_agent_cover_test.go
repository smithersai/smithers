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

func commandsAgentCovSetConfig(t *testing.T, apiURL, token string) {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(t.TempDir(), "cache"))
	t.Setenv("SMITHERS_TOKEN", token)
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(t.TempDir(), "auth.json"))
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commandsAgentCovInstallFakeJj(t *testing.T, repoRoot, remotes, status string) string {
	t.Helper()
	binDir := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
case "$1 $2 $3" in
  '--version  ') echo 'jj 0.33.0' ;;
  'root  ') printf '%s\n' "$SMITHERS_AGENT_COV_ROOT" ;;
  'git remote list') printf '%s\n' "$SMITHERS_AGENT_COV_REMOTES" ;;
  'status  ') printf '%s\n' "$SMITHERS_AGENT_COV_STATUS" ;;
  *) echo "unexpected jj args: $*" >&2; exit 1 ;;
esac
`
	if err := os.WriteFile(filepath.Join(binDir, "jj"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	t.Setenv("SMITHERS_AGENT_COV_ROOT", repoRoot)
	t.Setenv("SMITHERS_AGENT_COV_REMOTES", remotes)
	t.Setenv("SMITHERS_AGENT_COV_STATUS", status)
	return binDir
}

func commandsAgentCovChdir(t *testing.T, dir string) {
	t.Helper()
	oldwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(oldwd)
	})
}

func commandsAgentCovServe(t *testing.T, cli *incur.Cli, argv []string) string {
	t.Helper()
	var stdout bytes.Buffer
	if err := cli.ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("ServeWithOptions(%v) returned error: %v\n%s", argv, err, stdout.String())
	}
	return stdout.String()
}

func TestCommandsAgent_Cov_LocalHelpersAndRepoContext(t *testing.T) {
	repoRoot := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(repoRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	resolvedRepoRoot, err := filepath.EvalSymlinks(repoRoot)
	if err != nil {
		resolvedRepoRoot = repoRoot
	}
	commandsAgentCovSetConfig(t, "https://api.example.test", "")
	commandsAgentCovInstallFakeJj(t, repoRoot, "upstream https://example.test/team/fallback.git\norigin git@ssh.example.test:team/origin.git", "The working copy is clean")
	commandsAgentCovChdir(t, repoRoot)

	help := commandsAgentCovServe(t, agentCommand(), []string{"--help"})
	if !strings.Contains(help, "remote agent sessions") {
		t.Fatalf("agent help missing session text:\n%s", help)
	}
	ready := commandsAgentCovServe(t, agentCommand(), []string{"ask", "--json"})
	var readyPayload map[string]any
	if err := json.Unmarshal([]byte(ready), &readyPayload); err != nil {
		t.Fatalf("invalid ready JSON: %v\n%s", err, ready)
	}
	if readyPayload["status"] != "ready" {
		t.Fatalf("agent ask without prompt = %#v", readyPayload)
	}

	if opts := agentMessageOptions(true); opts.Properties["title"] == nil || opts.Properties["provider"].Default != "smithers" {
		t.Fatalf("agentMessageOptions(includeTitle) = %#v", opts.Properties)
	}
	if opts := agentMessageOptions(false); opts.Properties["title"] != nil {
		t.Fatalf("agentMessageOptions(false) should omit title: %#v", opts.Properties)
	}

	if root := detectAgentRepoRoot(repoRoot); root != resolvedRepoRoot {
		t.Fatalf("detectAgentRepoRoot = %q, want %q", root, resolvedRepoRoot)
	}
	if got := trimAgentOutput(" \n hello \n "); got != "hello" {
		t.Fatalf("trimAgentOutput = %#v", got)
	}
	if trimAgentOutput(" \n ") != nil {
		t.Fatal("trimAgentOutput should return nil for blank output")
	}
	long := strings.Repeat("x", 8001)
	if got := stringValue(trimAgentOutput(long)); !strings.HasSuffix(got, "\n...[truncated]") || !strings.HasPrefix(got, strings.Repeat("x", 8000)) {
		t.Fatalf("trimAgentOutput did not truncate with marker: len=%d suffix=%q", len(got), got[len(got)-20:])
	}
	if nilIfEmpty(" \t ") != nil || nilIfEmpty("value") != "value" {
		t.Fatal("nilIfEmpty returned unexpected values")
	}

	okCommand := captureAgentCommand("/bin/sh", []string{"-c", "printf output"}, repoRoot)
	if okCommand["ok"] != true || okCommand["output"] != "output" {
		t.Fatalf("captureAgentCommand success = %#v", okCommand)
	}
	badCommand := captureAgentCommand("/bin/sh", []string{"-c", "exit 3"}, repoRoot)
	if badCommand["ok"] != false || stringValue(badCommand["error"]) == "" {
		t.Fatalf("captureAgentCommand failure = %#v", badCommand)
	}

	if got := detectAgentRepoSlugFromRemotes("upstream https://example.test/team/fallback.git\norigin git@ssh.example.test:team/origin.git"); got != "team/origin" {
		t.Fatalf("detectAgentRepoSlugFromRemotes origin = %q", got)
	}
	if got := detectAgentRepoSlugFromRemotes("backup https://example.test/team/fallback.git"); got != "team/fallback" {
		t.Fatalf("detectAgentRepoSlugFromRemotes fallback = %q", got)
	}
	if got := detectAgentRepoSlugFromRemotes("garbage"); got != "" {
		t.Fatalf("detectAgentRepoSlugFromRemotes garbage = %q", got)
	}

	context, err := collectAgentRepoContext("alice/override")
	if err != nil {
		t.Fatalf("collectAgentRepoContext returned error: %v", err)
	}
	if context["repoSource"] != "override" || context["repoSlug"] != "alice/override" {
		t.Fatalf("repo override context = %#v", context)
	}
	if objectValue(context["remoteRepo"])["checked"] == true {
		t.Fatalf("remote repo should not be checked without auth: %#v", context["remoteRepo"])
	}

	summary, err := agentSummary("explain login", "alice/override")
	if err != nil {
		t.Fatalf("agentSummary returned error: %v", err)
	}
	if objectValue(summary)["backend"] != "local" || objectValue(summary)["response"] != "explain login" {
		t.Fatalf("agentSummary = %#v", summary)
	}

	docsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "# Smithers Docs\n\n## Login\n\nUse smithers auth login for browser authentication.\n")
	}))
	defer docsServer.Close()
	t.Setenv("SMITHERS_AGENT_DOCS_URL", docsServer.URL)
	response, err := runLocalAgentPrompt(&incur.CommandContext{FormatExplicit: true}, "browser login", "alice/override")
	if err != nil {
		t.Fatalf("runLocalAgentPrompt returned error: %v", err)
	}
	payload := objectValue(response)
	if payload["backend"] != "local" || !strings.Contains(stringValue(payload["response"]), "smithers auth login") {
		t.Fatalf("runLocalAgentPrompt payload = %#v", payload)
	}
}

func TestCommandsAgent_Cov_RemoteSessionCommandsAndMessages(t *testing.T) {
	var seen []string
	var messageProviders []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.RequestURI())
		if got := r.Header.Get("Authorization"); got != "token commands_agent_cov_token" {
			t.Fatalf("Authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		escapedPath := r.URL.EscapedPath()
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/agent/sessions":
			if r.URL.Query().Get("page") != "2" || r.URL.Query().Get("per_page") != "5" {
				t.Fatalf("session list query = %s", r.URL.RawQuery)
			}
			fmt.Fprint(w, `[{"id":"sess/one"}]`)
		case r.Method == http.MethodGet && escapedPath == "/api/repos/alice/demo/agent/sessions/sess%2Fone":
			fmt.Fprint(w, `{"id":"sess/one","title":"Viewed"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/agent/sessions":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("invalid session body: %v", err)
			}
			if body["title"] == "no id" {
				fmt.Fprint(w, `{}`)
				return
			}
			fmt.Fprintf(w, `{"id":"sess/one","title":%q}`, stringValue(body["title"]))
		case r.Method == http.MethodPost && strings.HasSuffix(escapedPath, "/messages"):
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("invalid message body: %v", err)
			}
			messageProviders = append(messageProviders, stringValue(body["agent_provider"])+"/"+stringValue(body["agent_transport"]))
			parts := arrayValue(body["parts"])
			if body["role"] != "user" || len(parts) != 1 || stringValue(objectValue(parts[0])["content"]) == "" {
				t.Fatalf("message body = %#v", body)
			}
			fmt.Fprint(w, `{"ok":true}`)
		default:
			t.Fatalf("unexpected agent request: %s %s", r.Method, r.URL.RequestURI())
		}
	}))
	defer server.Close()
	commandsAgentCovSetConfig(t, server.URL, "commands_agent_cov_token")

	session, err := createAgentSession("alice", "demo", "Direct")
	if err != nil || stringValue(objectValue(session)["id"]) != "sess/one" {
		t.Fatalf("createAgentSession = (%#v, %v)", session, err)
	}
	if _, err = sendAgentMessage("alice", "demo", "direct", "hello", "", ""); err != nil {
		t.Fatalf("sendAgentMessage defaults returned error: %v", err)
	}
	if _, err = sendAgentMessage("alice", "demo", "direct", "hello", "codex", "http"); err != nil {
		t.Fatalf("sendAgentMessage explicit returned error: %v", err)
	}

	commandsAgentCovServe(t, agentCommand(), []string{"list", "--repo", "alice/demo", "--page", "2", "--per-page", "5", "--json"})
	commandsAgentCovServe(t, agentCommand(), []string{"session", "view", "sess/one", "--repo", "alice/demo", "--json"})
	commandsAgentCovServe(t, agentCommand(), []string{"run", "Do work", "--repo", "alice/demo", "--title", "Launch", "--provider", "codex", "--transport", "http", "--json"})
	commandsAgentCovServe(t, agentSessionCommand(), []string{"chat", "sess/one", "hello again", "--repo", "alice/demo", "--json"})

	var stdout bytes.Buffer
	err = agentCommand().ServeWithOptions([]string{"run", "No ID", "--repo", "alice/demo", "--title", "no id", "--json"}, incur.ServeOptions{Stdout: &stdout})
	if err == nil || !strings.Contains(err.Error(), "did not include id") {
		t.Fatalf("agent run missing id error = %v stdout=%s", err, stdout.String())
	}
	if len(messageProviders) < 4 {
		t.Fatalf("expected message posts, saw providers %v and requests %v", messageProviders, seen)
	}
	if messageProviders[0] != "smithers/workflow" || messageProviders[1] != "codex/http" {
		t.Fatalf("message provider defaults/explicit = %v", messageProviders)
	}
}

func TestCommandsAgent_Cov_RemoteRepo(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "token commands_agent_cov_token" {
			t.Fatalf("Authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo":
			fmt.Fprint(w, `{"full_name":"alice/demo"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/missing":
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
		}
	}))
	defer server.Close()
	commandsAgentCovSetConfig(t, server.URL, "commands_agent_cov_token")

	noRepo := checkAgentRemoteRepo("", AuthStatusResult{LoggedIn: true})
	if noRepo["checked"] == true || !strings.Contains(stringValue(noRepo["message"]), "No Smithers repo") {
		t.Fatalf("checkAgentRemoteRepo empty = %#v", noRepo)
	}
	noAuth := checkAgentRemoteRepo("alice/demo", AuthStatusResult{LoggedIn: false})
	if noAuth["checked"] == true || !strings.Contains(stringValue(noAuth["message"]), "auth is unavailable") {
		t.Fatalf("checkAgentRemoteRepo no auth = %#v", noAuth)
	}
	invalid := checkAgentRemoteRepo("bad", AuthStatusResult{LoggedIn: true})
	if invalid["checked"] == true || stringValue(invalid["message"]) == "" {
		t.Fatalf("checkAgentRemoteRepo invalid = %#v", invalid)
	}
	available := checkAgentRemoteRepo("alice/demo", AuthStatusResult{LoggedIn: true})
	if available["checked"] != true || available["available"] != true {
		t.Fatalf("checkAgentRemoteRepo available = %#v", available)
	}
	missing := checkAgentRemoteRepo("alice/missing", AuthStatusResult{LoggedIn: true})
	if missing["checked"] != true || missing["available"] != false || !strings.Contains(stringValue(missing["message"]), "missing") {
		t.Fatalf("checkAgentRemoteRepo missing = %#v", missing)
	}
}
