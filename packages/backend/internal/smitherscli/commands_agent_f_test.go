package smitherscli

import (
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

const agentFJjScript = `#!/bin/sh
case "$1 $2 $3" in
  '--version  ') echo 'jj 0.99.0'; exit "${AGENTF_VERSION_CODE:-0}" ;;
  'root  ') printf '%s\n' "$AGENTF_ROOT"; exit "${AGENTF_ROOT_CODE:-0}" ;;
  'git remote list') printf '%s\n' "$AGENTF_REMOTES"; exit "${AGENTF_REMOTES_CODE:-0}" ;;
  'status  ') printf '%s\n' "$AGENTF_STATUS"; exit "${AGENTF_STATUS_CODE:-0}" ;;
  *) echo "unexpected jj args: $*" >&2; exit 1 ;;
esac
`

func agentFInstallJj(t *testing.T) {
	t.Helper()
	binDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(binDir, "jj"), []byte(agentFJjScript), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
}

func agentFSetConfig(t *testing.T, apiURL, token string) {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(t.TempDir(), "cache"))
	t.Setenv("SMITHERS_TOKEN", token)
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	setTestCredentialStoreFile(t, "")
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(t.TempDir(), "auth.json"))
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

type agentFServer struct {
	failSuffix string
}

func (s *agentFServer) start(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if s.failSuffix != "" && strings.HasSuffix(p, s.failSuffix) {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"forced"}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case p == "/api/user":
			fmt.Fprint(w, `{"login":"alice","email":"a@b.com"}`)
		case strings.HasSuffix(p, "/messages"):
			fmt.Fprint(w, `{"id":"m1"}`)
		case strings.HasSuffix(p, "/sessions") && r.Method == http.MethodPost:
			fmt.Fprint(w, `{"id":"s1"}`)
		case strings.HasSuffix(p, "/sessions"):
			fmt.Fprint(w, `[]`)
		default:
			fmt.Fprint(w, `{}`)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func agentFServe(t *testing.T, argv ...string) error {
	t.Helper()
	var out strings.Builder
	return agentCommand().ServeWithOptions(argv, incur.ServeOptions{Stdout: &out, Stderr: &out})
}

func TestCommandsAgent_F_DetectRepoRoot(t *testing.T) {
	agentFInstallJj(t)
	t.Setenv("AGENTF_ROOT_CODE", "1")
	if root := detectAgentRepoRoot("."); root != "" {
		t.Fatalf("detectAgentRepoRoot err = %q", root)
	}
	t.Setenv("AGENTF_ROOT_CODE", "0")
	t.Setenv("AGENTF_ROOT", "")
	if root := detectAgentRepoRoot("."); root != "" {
		t.Fatalf("detectAgentRepoRoot empty = %q", root)
	}
	t.Setenv("AGENTF_ROOT", "/nonexistent/path/xyz")
	if root := detectAgentRepoRoot("."); root != "/nonexistent/path/xyz" {
		t.Fatalf("detectAgentRepoRoot unresolved = %q", root)
	}
}

func TestCommandsAgent_F_DetectRepoSlug(t *testing.T) {
	agentFSetConfig(t, "https://api.smithers.test", "")
	if got := detectAgentRepoSlugFromRemotes(""); got != "" {
		t.Fatalf("detectAgentRepoSlugFromRemotes empty = %q", got)
	}
	if got := detectAgentRepoSlugFromRemotes("upstream https://github.com/x/y (fetch)\nsolo"); got != "" {
		t.Fatalf("detectAgentRepoSlugFromRemotes non-matching = %q", got)
	}
}

func TestCommandsAgent_F_CollectRepoContext(t *testing.T) {
	url := (&agentFServer{}).start(t)

	// success with detected slug + auth user
	agentFInstallJj(t)
	agentFSetConfig(t, url, "tok")
	host := hostFromURL(url)
	t.Setenv("AGENTF_ROOT", t.TempDir())
	t.Setenv("AGENTF_REMOTES", "origin git@ssh."+host+":team/origin.git")
	t.Setenv("AGENTF_STATUS", "clean")
	ctx, err := collectAgentRepoContext("")
	if err != nil {
		t.Fatalf("collectAgentRepoContext success = %v", err)
	}
	if stringValue(ctx["repoSlug"]) != "team/origin" {
		t.Fatalf("collectAgentRepoContext slug = %v", ctx["repoSlug"])
	}

	// warnings: no root, remotes fail, status fail, no override
	t.Setenv("AGENTF_ROOT", "")
	t.Setenv("AGENTF_REMOTES_CODE", "1")
	t.Setenv("AGENTF_STATUS_CODE", "1")
	if _, err := collectAgentRepoContext(""); err != nil {
		t.Fatalf("collectAgentRepoContext warnings = %v", err)
	}
	t.Setenv("AGENTF_REMOTES_CODE", "0")
	t.Setenv("AGENTF_STATUS_CODE", "0")

	// override ResolveRepoRef error
	if _, err := collectAgentRepoContext("badformat"); err == nil {
		t.Fatal("collectAgentRepoContext override error expected")
	}

	// Getwd error seam
	oldGetwd := agentGetwd
	agentGetwd = func() (string, error) { return "", errors.New("getwd boom") }
	if _, err := collectAgentRepoContext(""); err != nil {
		t.Fatalf("collectAgentRepoContext getwd = %v", err)
	}
	agentGetwd = oldGetwd
}

func TestCommandsAgent_F_CollectRepoContextNoJj(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	agentFSetConfig(t, "https://api.example.test", "")
	ctx, err := collectAgentRepoContext("")
	if err != nil {
		t.Fatalf("collectAgentRepoContext without jj = %v", err)
	}
	if ctx["repoRoot"] != nil || len(arrayValue(ctx["warnings"])) == 0 {
		t.Fatalf("collectAgentRepoContext without jj should degrade to warnings: %#v", ctx)
	}
}

func TestCommandsAgent_F_LocalPromptAndSummary(t *testing.T) {
	t.Setenv("SMITHERS_AGENT_DOCS_URL", "http://127.0.0.1:1/docs")
	url := (&agentFServer{}).start(t)
	agentFInstallJj(t)
	agentFSetConfig(t, url, "tok")
	t.Setenv("AGENTF_ROOT", t.TempDir())
	t.Setenv("AGENTF_REMOTES", "")
	t.Setenv("AGENTF_STATUS", "clean")

	// collect error path
	if _, err := runLocalAgentPrompt(&incur.CommandContext{}, "p", "badformat"); err == nil {
		t.Fatal("runLocalAgentPrompt collect error expected")
	}
	if _, err := agentSummary("p", "badformat"); err == nil {
		t.Fatal("agentSummary collect error expected")
	}

	// non-explicit, no repo slug -> plain response
	if _, err := runLocalAgentPrompt(&incur.CommandContext{}, "p", ""); err != nil {
		t.Fatalf("runLocalAgentPrompt no-slug = %v", err)
	}
	// non-explicit, with repo slug -> "Repo:" prefix
	if _, err := runLocalAgentPrompt(&incur.CommandContext{}, "p", "alice/demo"); err != nil {
		t.Fatalf("runLocalAgentPrompt slug = %v", err)
	}

	if _, err := agentSummary("p", "alice/demo"); err != nil {
		t.Fatalf("agentSummary = %v", err)
	}
}

func TestCommandsAgent_F_AskHandler(t *testing.T) {
	t.Setenv("SMITHERS_AGENT_DOCS_URL", "http://127.0.0.1:1/docs")
	url := (&agentFServer{}).start(t)
	agentFInstallJj(t)
	agentFSetConfig(t, url, "tok")
	t.Setenv("AGENTF_ROOT", t.TempDir())
	t.Setenv("AGENTF_REMOTES", "")
	t.Setenv("AGENTF_STATUS", "clean")

	t.Setenv("SMITHERS_AGENT_TEST_MODE", "summary")
	if err := agentFServe(t, "ask", "hi"); err != nil {
		t.Fatalf("agent ask summary = %v", err)
	}
	t.Setenv("SMITHERS_AGENT_TEST_MODE", "")
	if err := agentFServe(t, "ask", "hi"); err != nil {
		t.Fatalf("agent ask local = %v", err)
	}
}

func TestCommandsAgent_F_RemoteSessionCommands(t *testing.T) {
	// ResolveRepoRef errors
	agentFSetConfig(t, "http://127.0.0.1:1", "tok")
	t.Setenv("PATH", t.TempDir())
	for _, argv := range [][]string{
		{"list", "--repo", "badformat"},
		{"view", "s1", "--repo", "badformat"},
		{"run", "prompt", "--repo", "badformat"},
		{"chat", "s1", "hi", "--repo", "badformat"},
	} {
		if err := agentFServe(t, argv...); err == nil {
			t.Fatalf("expected ResolveRepoRef error for %v", argv)
		}
	}

	// run: createAgentSession error (unreachable)
	if err := agentFServe(t, "run", "prompt", "--repo", "alice/demo"); err == nil {
		t.Fatal("run createAgentSession error expected")
	}
}

func TestCommandsAgent_F_RunSuccessAndMessageError(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	longPrompt := strings.Repeat("a", 70)

	// success: title derived from long prompt (truncated)
	srv := &agentFServer{}
	agentFSetConfig(t, srv.start(t), "tok")
	if err := agentFServe(t, "run", longPrompt, "--repo", "alice/demo"); err != nil {
		t.Fatalf("run success = %v", err)
	}

	// sendAgentMessage error
	srvFail := &agentFServer{failSuffix: "/messages"}
	agentFSetConfig(t, srvFail.start(t), "tok")
	if err := agentFServe(t, "run", "prompt", "--repo", "alice/demo"); err == nil {
		t.Fatal("run sendMessage error expected")
	}
}
