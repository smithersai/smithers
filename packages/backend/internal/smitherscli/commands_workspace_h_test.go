package smitherscli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	incur "github.com/smithersai/incur"
)

func commandsWorkspaceHSetAuthConfig(t *testing.T, apiURL string) {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	t.Setenv("SMITHERS_TOKEN", "commands_workspace_h_token")
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commandsWorkspaceHServe(t *testing.T, argv ...string) string {
	t.Helper()
	var stdout bytes.Buffer
	if err := workspaceCommand().ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("workspace %v returned error: %v\n%s", argv, err, stdout.String())
	}
	return stdout.String()
}

func commandsWorkspaceHServeWantErr(t *testing.T, want string, argv ...string) {
	t.Helper()
	var stdout bytes.Buffer
	err := workspaceCommand().ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout})
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("workspace %v error = %v, want contains %q\n%s", argv, err, want, stdout.String())
	}
}

func commandsWorkspaceHInstallFakeSSH(t *testing.T) string {
	t.Helper()
	binDir := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
if [ -n "${COMMANDS_WORKSPACE_H_SSH_EXIT:-}" ]; then
  exit "$COMMANDS_WORKSPACE_H_SSH_EXIT"
fi
last=""
for arg in "$@"; do
  last="$arg"
done
case "$last" in
  *stream-exit-6*) printf 'stream failed\n'; exit 6 ;;
  *stream-sleep*) sleep 2; exit 0 ;;
  *stream-ok*) printf 'stream ok\n'; exit 0 ;;
esac
stdin=$(cat)
if printf '%s' "$stdin" | grep -q 'timeout-sleep'; then
  sleep 2
fi
if printf '%s' "$stdin" | grep -q 'stderr-only'; then
  printf 'stderr detail\n' >&2
  exit 9
fi
begin=$(printf '%s' "$stdin" | grep -o '__SMITHERS_BEGIN_[A-Za-z0-9_]*__' | head -n 1)
end=$(printf '%s' "$stdin" | grep -o '__SMITHERS_END_[A-Za-z0-9_]*__' | head -n 1)
if [ -z "$begin" ]; then
  exit 0
fi
status=0
output='remote ok'
if printf '%s' "$stdin" | grep -q 'fail-remote'; then
  status=5
  output='remote failed'
fi
if printf '%s' "$stdin" | grep -q 'jj log'; then
  if [ "${COMMANDS_WORKSPACE_H_JJ_LOG_FAIL:-}" = "1" ]; then
    status=4
    output='jj failed'
  elif [ "${COMMANDS_WORKSPACE_H_NO_CHANGES:-}" = "1" ]; then
    output=''
  else
    output='chg-a
chg-b'
  fi
fi
if printf '%s' "$stdin" | grep -q 'printf ready'; then
  if [ "${COMMANDS_WORKSPACE_H_AUTH_CHECK_FAIL:-}" = "1" ]; then
    status=8
    output='auth check failed'
  elif [ "${COMMANDS_WORKSPACE_H_AUTH_READY:-1}" = "1" ]; then
    output='ready'
  else
    output='not ready'
  fi
fi
if printf '%s' "$stdin" | grep -q 'claude_processes'; then
  if [ "${COMMANDS_WORKSPACE_H_DIAG_FAIL:-}" = "1" ]; then
    status=6
    output='diagnostics failed'
  else
    output='diagnostic output'
  fi
fi
if [ "${COMMANDS_WORKSPACE_H_CLAUDE_FAIL:-}" = "1" ] && printf '%s' "$stdin" | grep -q 'claude -p'; then
  status=3
  output='claude failed'
fi
printf '%s\n' "$begin"
printf '%s\n' "$output"
printf '\n%s:%s\n' "$end" "$status"
exit "$status"
`
	if err := os.WriteFile(filepath.Join(binDir, "ssh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("SMITHERS_WORKSPACE_KNOWN_HOSTS_FILE", filepath.Join(t.TempDir(), "known_hosts"))
	return "ssh developer@example.com"
}

func commandsWorkspaceHWithEmptyStdin(t *testing.T, fn func()) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "stdin")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdin
	os.Stdin = file
	t.Cleanup(func() {
		os.Stdin = old
		_ = file.Close()
	})
	fn()
}

func TestCommandsWorkspace_H_CommandHandlersAndTerminal(t *testing.T) {
	sshCommand := commandsWorkspaceHInstallFakeSSH(t)
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "anthropic-h-token")
	t.Setenv("OPENAI_API_KEY", "openai-h-token")
	t.Setenv("SMITHERS_TEST_CODEX_AUTH_JSON", "")
	t.Setenv("SMITHERS_WORKSPACE_SSH_POLL_INTERVAL_MS", "1")
	t.Setenv("SMITHERS_WORKSPACE_SSH_POLL_TIMEOUT_MS", "50")
	t.Setenv("SMITHERS_WORKSPACE_REMOTE_COMMAND_TIMEOUT_MS", "5000")
	t.Setenv("SMITHERS_WORKSPACE_CLAUDE_TIMEOUT_MS", "5000")

	var sessionDestroyed bool
	var landingBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); strings.HasPrefix(r.URL.Path, "/api/") && got != "token commands_workspace_h_token" {
			t.Errorf("Authorization header = %q for %s", got, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces":
			fmt.Fprint(w, `[{"id":"ws-running","status":"running"},{"id":"ws-stopped","status":"stopped"}]`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/workspaces":
			fmt.Fprint(w, `{"id":"ws-created"}`)
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/repos/alice/demo/workspaces/") && strings.HasSuffix(r.URL.Path, "/ssh"):
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/repos/alice/demo/workspaces/"), "/ssh")
			if id == "ws-no-command" {
				fmt.Fprint(w, `{"host":"host-only","port":2222}`)
				return
			}
			fmt.Fprintf(w, `{"command":%q,"host":"host","port":22,"username":"developer"}`, sshCommand)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-view":
			fmt.Fprint(w, `{"id":"ws-view","status":"running","created_at":"2026-01-01T00:00:00Z","persistence":"","snapshot_id":null}`)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-delete":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-fork/fork":
			fmt.Fprint(w, `{"id":"ws-forked"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-snap/snapshots":
			fmt.Fprint(w, `[{"id":"snap-1"}]`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-watch":
			fmt.Fprint(w, `{"id":"ws-watch","name":"watch me","status":"running"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-watch/stream":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "id: 1\nevent: activity\ndata: {\"action\":\"build\",\"message\":\"started\"}\n\n")
			fmt.Fprint(w, "event: activity\ndata: {\"action\":\"done\"}\n\n")
			fmt.Fprint(w, "event: status\ndata: {\"status\":\"deleted\"}\n\n")
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/workspace/sessions":
			fmt.Fprint(w, `{"id":"sess-h"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspace/sessions/sess-h/terminal":
			conn, err := websocket.Accept(w, r, nil)
			if err != nil {
				t.Errorf("websocket accept: %v", err)
				return
			}
			defer conn.Close(websocket.StatusNormalClosure, "")
			_, _, _ = conn.Read(context.Background())
			_ = conn.Write(context.Background(), websocket.MessageText, []byte(`{"type":"status","status":"stopped"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/workspace/sessions/sess-h/destroy":
			sessionDestroyed = true
			fmt.Fprint(w, `{"destroyed":true}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/issues/8":
			fmt.Fprint(w, `{"number":8,"title":"Issue title","body":"Issue body","labels":[{"name":"bug"},{"name":"cli"}]}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/landings":
			if err := json.NewDecoder(r.Body).Decode(&landingBody); err != nil {
				t.Errorf("landing body decode: %v", err)
			}
			fmt.Fprint(w, `{"number":88}`)
		default:
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		}
	}))
	defer server.Close()
	commandsWorkspaceHSetAuthConfig(t, server.URL)

	commandsWorkspaceHServe(t, "create", "--repo", "alice/demo", "--name", "created", "--snapshot", "snap-1", "--json")
	commandsWorkspaceHServe(t, "list", "--repo", "alice/demo", "--json")
	commandsWorkspaceHServe(t, "view", "ws-view", "--repo", "alice/demo", "--json")
	commandsWorkspaceHServe(t, "delete", "ws-delete", "--repo", "alice/demo", "--json")
	commandsWorkspaceHServe(t, "ssh", "ws-ssh", "--repo", "alice/demo", "--json")
	commandsWorkspaceHServeWantErr(t, "not become SSH-ready", "ssh", "ws-no-command", "--repo", "alice/demo", "--json")
	commandsWorkspaceHServe(t, "fork", "ws-fork", "--repo", "alice/demo", "--name", "forked", "--json")
	commandsWorkspaceHServe(t, "snapshots", "ws-snap", "--repo", "alice/demo", "--json")
	commandsWorkspaceHServe(t, "watch", "ws-watch", "--repo", "alice/demo", "--json")
	commandsWorkspaceHWithEmptyStdin(t, func() {
		commandsWorkspaceHServe(t, "shell", "ws-shell", "--repo", "alice/demo", "--cols", "100", "--rows", "30", "--json")
	})
	if !sessionDestroyed {
		t.Fatal("workspace shell did not destroy the terminal session")
	}
	commandsWorkspaceHServe(t, "exec", "ws-exec", "--repo", "alice/demo", "--command", "stream-ok", "--timeout", "1", "--seedAgentAuth", "claude,codex", "--json")
	commandsWorkspaceHServeWantErr(t, "remote command exited with code 6", "exec", "ws-exec", "--repo", "alice/demo", "--command", "stream-exit-6", "--timeout", "1", "--json")
	commandsWorkspaceHServe(t, "issue", "8", "--repo", "alice/demo", "--target", "main", "--json")
	if landingBody["target_bookmark"] != "main" || len(arrayValue(landingBody["change_ids"])) != 2 {
		t.Fatalf("landing body = %#v", landingBody)
	}
}

func TestCommandsWorkspace_H_HelperBranchesAndErrors(t *testing.T) {
	sshCommand := commandsWorkspaceHInstallFakeSSH(t)
	t.Setenv("SMITHERS_WORKSPACE_REMOTE_COMMAND_TIMEOUT_MS", "5000")
	t.Setenv("SMITHERS_WORKSPACE_CLAUDE_TIMEOUT_MS", "5000")
	t.Setenv("SMITHERS_WORKSPACE_SSH_POLL_INTERVAL_MS", "1")
	t.Setenv("SMITHERS_WORKSPACE_SSH_POLL_TIMEOUT_MS", "5")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("SMITHERS_TEST_CLAUDE_KEYCHAIN_PAYLOAD", `not-json`)
	t.Setenv("SMITHERS_TEST_CODEX_AUTH_JSON", "")
	t.Setenv("HOME", t.TempDir())

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/repos/alice/error/workspaces":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"workspace list failed"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/stopped/workspaces":
			fmt.Fprint(w, `[{"id":"ws-stopped","status":"stopped"}]`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/empty/workspaces":
			fmt.Fprint(w, `[]`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/empty/workspaces":
			fmt.Fprint(w, `{"id":"ws-new"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/missingid/workspaces":
			fmt.Fprint(w, `[]`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/missingid/workspaces":
			fmt.Fprint(w, `{}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-timeout/ssh":
			fmt.Fprint(w, `{"host":"not-ready"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-stream-status/stream":
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprint(w, `bad stream`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-stream-tail/stream":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "event: activity\ndata: {\"action\":\"tail\"}\n\n")
			fmt.Fprint(w, "data: raw tail")
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/issues/9":
			fmt.Fprint(w, `{"number":9,"title":"No changes","body":""}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/workspaces":
			fmt.Fprint(w, `{"id":"ws-issue"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-issue/ssh":
			fmt.Fprintf(w, `{"command":%q}`, sshCommand)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/landings":
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprint(w, `{"message":"landing denied"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		}
	}))
	defer server.Close()
	commandsWorkspaceHSetAuthConfig(t, server.URL)

	if _, _, _, err := resolveWorkspaceID(&incur.CommandContext{Options: map[string]any{"repo": "not-a-repo"}}); err == nil || !strings.Contains(err.Error(), "Invalid repo format") {
		t.Fatalf("resolveWorkspaceID bad repo = %v", err)
	}
	if _, _, _, err := resolveWorkspaceID(&incur.CommandContext{Options: map[string]any{"repo": "alice/error"}}); err == nil || !strings.Contains(err.Error(), "workspace list failed") {
		t.Fatalf("resolveWorkspaceID API error = %v", err)
	}
	_, _, id, err := resolveWorkspaceID(&incur.CommandContext{Options: map[string]any{"repo": "alice/stopped"}})
	if err != nil || id != "ws-stopped" {
		t.Fatalf("resolveWorkspaceID stopped fallback = %q, %v", id, err)
	}
	_, _, id, err = resolveWorkspaceID(&incur.CommandContext{Options: map[string]any{"repo": "alice/empty"}})
	if err != nil || id != "ws-new" {
		t.Fatalf("resolveWorkspaceID create = %q, %v", id, err)
	}
	if _, _, _, err = resolveWorkspaceID(&incur.CommandContext{Options: map[string]any{"repo": "alice/missingid"}}); err == nil || !strings.Contains(err.Error(), "did not include id") {
		t.Fatalf("resolveWorkspaceID missing id = %v", err)
	}
	if _, err = waitForWorkspaceSSHInfo("alice", "demo", "ws-timeout"); err == nil || !strings.Contains(err.Error(), "not become SSH-ready") {
		t.Fatalf("waitForWorkspaceSSHInfo timeout = %v", err)
	}
	if _, err = streamWorkspaceEvents("alice", "demo", "ws-stream-status"); err == nil || !strings.Contains(err.Error(), "Failed to connect") {
		t.Fatalf("streamWorkspaceEvents status = %v", err)
	}
	events, err := streamWorkspaceEvents("alice", "demo", "ws-stream-tail")
	if err != nil || len(events) != 2 {
		t.Fatalf("streamWorkspaceEvents tail flush = (%#v, %v)", events, err)
	}

	command, timeout, err := normalizeWorkspaceExecOptions(" echo hi ", 2)
	if err != nil || command != "echo hi" || timeout != 2*time.Second {
		t.Fatalf("normalizeWorkspaceExecOptions custom = %q, %s, %v", command, timeout, err)
	}
	if _, _, err = normalizeWorkspaceExecOptions(" ", 0); err == nil || !strings.Contains(err.Error(), "--command is required") {
		t.Fatalf("normalizeWorkspaceExecOptions blank = %v", err)
	}
	def := workspaceIDCommandWithOptions("bad repo", nil, func(owner, repo, id string, ctx *incur.CommandContext) (any, error) { return nil, nil })
	if _, err := def.Handler(&incur.CommandContext{Args: map[string]any{"id": "ws"}, Options: map[string]any{"repo": "bad"}}); err == nil {
		t.Fatal("workspaceIDCommandWithOptions accepted a bad repo")
	}
	if view := objectValue(workspaceSSHView(map[string]any{}, map[string]any{})); view["command"] != "SSH details available" {
		t.Fatalf("workspaceSSHView details fallback = %#v", view)
	}
	if view := objectValue(workspaceSSHView(map[string]any{"ssh_host": "from-ws"}, map[string]any{})); view["command"] != "ssh from-ws" {
		t.Fatalf("workspaceSSHView workspace host via sshInfo = %#v", view)
	}
	t.Setenv("SMITHERS_WORKSPACE_KNOWN_HOSTS_FILE", "")
	if got := workspaceKnownHostsFile(); !strings.Contains(got, filepath.Join("smithers", "ssh", "known_hosts")) {
		t.Fatalf("workspaceKnownHostsFile default = %q", got)
	}
	if cols, rows := terminalSize(0, 0); cols != 120 || rows != 40 {
		t.Fatalf("terminalSize defaults = (%d, %d)", cols, rows)
	}

	t.Setenv("ANTHROPIC_AUTH_TOKEN", "direct-token")
	if env := getClaudeAuthEnv(); env["ANTHROPIC_AUTH_TOKEN"] != "direct-token" {
		t.Fatalf("getClaudeAuthEnv token = %#v", env)
	}
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_API_KEY", "api-key")
	if env := getClaudeAuthEnv(); env["ANTHROPIC_API_KEY"] != "api-key" {
		t.Fatalf("getClaudeAuthEnv api key = %#v", env)
	}
	t.Setenv("ANTHROPIC_API_KEY", "")
	var payload claudeCodeKeychainPayload
	if got := claudeKeychainAccessToken(payload); got != "" {
		t.Fatalf("claudeKeychainAccessToken empty = %q", got)
	}
	t.Setenv("OPENAI_API_KEY", "openai-key")
	content, ok := getCodexAuthContent()
	if !ok || !strings.Contains(content, "openai-key") {
		t.Fatalf("getCodexAuthContent api key = %q, %t", content, ok)
	}
	t.Setenv("OPENAI_API_KEY", "")
	if content, ok = getCodexAuthContent(); ok || content != "" {
		t.Fatalf("getCodexAuthContent empty = %q, %t", content, ok)
	}

	if got := parseSeedAgentAuthList("claude, codex,claude,,unknown"); !reflect.DeepEqual(got, []string{"claude", "codex", "unknown"}) {
		t.Fatalf("parseSeedAgentAuthList = %#v", got)
	}
	if err := seedWorkspaceAgentAuth(sshCommand, []string{"claude"}); err == nil || !strings.Contains(err.Error(), "Claude Code auth is not available") {
		t.Fatalf("seedWorkspaceAgentAuth missing claude = %v", err)
	}
	if err := seedWorkspaceAgentAuth(sshCommand, []string{"codex"}); err == nil || !strings.Contains(err.Error(), "Codex auth is not available") {
		t.Fatalf("seedWorkspaceAgentAuth missing codex = %v", err)
	}
	if err := seedWorkspaceAgentAuth(sshCommand, []string{"unknown"}); err == nil || !strings.Contains(err.Error(), "unknown --seed-agent-auth") {
		t.Fatalf("seedWorkspaceAgentAuth unknown = %v", err)
	}
	t.Setenv("COMMANDS_WORKSPACE_H_AUTH_READY", "0")
	if err := ensureWorkspaceClaudeAuth(sshCommand); err == nil || !strings.Contains(err.Error(), "Claude Code auth is not configured") {
		t.Fatalf("ensureWorkspaceClaudeAuth not ready = %v", err)
	}
	t.Setenv("COMMANDS_WORKSPACE_H_AUTH_CHECK_FAIL", "1")
	if err := ensureWorkspaceClaudeAuth(sshCommand); err == nil || !strings.Contains(err.Error(), "auth check failed") {
		t.Fatalf("ensureWorkspaceClaudeAuth check failure = %v", err)
	}
	t.Setenv("COMMANDS_WORKSPACE_H_AUTH_CHECK_FAIL", "")

	t.Setenv("COMMANDS_WORKSPACE_H_CLAUDE_FAIL", "1")
	t.Setenv("COMMANDS_WORKSPACE_H_DIAG_FAIL", "1")
	if err := runWorkspaceClaudeCommand(sshCommand, "prompt"); err == nil || !strings.Contains(err.Error(), "Workspace diagnostics failed") {
		t.Fatalf("runWorkspaceClaudeCommand diagnostic failure = %v", err)
	}
	t.Setenv("COMMANDS_WORKSPACE_H_CLAUDE_FAIL", "")
	t.Setenv("COMMANDS_WORKSPACE_H_DIAG_FAIL", "")
	t.Setenv("COMMANDS_WORKSPACE_H_JJ_LOG_FAIL", "1")
	if _, err := listWorkspaceChangeIDs(sshCommand, "main"); err == nil || !strings.Contains(err.Error(), "jj failed") {
		t.Fatalf("listWorkspaceChangeIDs failure = %v", err)
	}
	t.Setenv("COMMANDS_WORKSPACE_H_JJ_LOG_FAIL", "")

	if code, output := extractRemoteShellOutput("__BEGIN__\nbody without end", "__BEGIN__", "__END__"); code != -1 || output != "body without end" {
		t.Fatalf("extractRemoteShellOutput missing end = (%d, %q)", code, output)
	}
	if code, output := extractRemoteShellOutput("__BEGIN__\nbody\n__END__:bad\n", "__BEGIN__", "__END__"); code != -1 || !strings.Contains(output, "__END__:bad") {
		t.Fatalf("extractRemoteShellOutput bad status = (%d, %q)", code, output)
	}
	oldRandRead := workspaceRandRead
	t.Cleanup(func() { workspaceRandRead = oldRandRead })
	workspaceRandRead = func([]byte) (int, error) { return 0, fmt.Errorf("no entropy") }
	if marker := randomMarkerID(); strings.TrimSpace(marker) == "" {
		t.Fatal("randomMarkerID fallback returned empty marker")
	}
	workspaceRandRead = oldRandRead
	if _, err := runRemoteShellCommand("missing-ssh-command", "echo hi", "start", false, time.Second); err == nil {
		t.Fatal("runRemoteShellCommand accepted missing executable")
	}
	if _, err := runRemoteShellCommand(sshCommand, "timeout-sleep", "slow", false, 10*time.Millisecond); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("runRemoteShellCommand timeout = %v", err)
	}
	if _, err := runRemoteShellCommand(sshCommand, "stderr-only", "stderr", false, time.Second); err == nil || !strings.Contains(err.Error(), "stderr detail") {
		t.Fatalf("runRemoteShellCommand stderr fallback = %v", err)
	}
	if _, err := runRemoteShellCommand(sshCommand, "fail-remote", "remote", true, time.Second); err == nil || !strings.Contains(err.Error(), "remote failed") {
		t.Fatalf("runRemoteShellCommand streamed failure = %v", err)
	}
	if _, err := runRemoteStreamedCommand("missing-ssh-command", "stream-ok", time.Second); err == nil {
		t.Fatal("runRemoteStreamedCommand accepted missing executable")
	}
	if _, err := runRemoteStreamedCommand(sshCommand, "stream-sleep", 10*time.Millisecond); err == nil || !strings.Contains(err.Error(), "workspace exec timed out") {
		t.Fatalf("runRemoteStreamedCommand timeout = %v", err)
	}

	t.Setenv("COMMANDS_WORKSPACE_H_AUTH_READY", "1")
	t.Setenv("COMMANDS_WORKSPACE_H_NO_CHANGES", "1")
	result, err := runWorkspaceIssue(&incur.CommandContext{Args: map[string]any{"number": "9"}, Options: map[string]any{"repo": "alice/demo", "target": "main"}})
	if err != nil || objectValue(result)["landing_request"] != nil || !strings.Contains(stringValue(objectValue(result)["message"]), "No non-empty changes") {
		t.Fatalf("runWorkspaceIssue no changes = (%#v, %v)", result, err)
	}
	t.Setenv("COMMANDS_WORKSPACE_H_NO_CHANGES", "")
	result, err = runWorkspaceIssue(&incur.CommandContext{Args: map[string]any{"number": "9"}, Options: map[string]any{"repo": "alice/demo", "target": "main"}})
	if err != nil || !strings.Contains(stringValue(objectValue(result)["message"]), "landing request could not be created") {
		t.Fatalf("runWorkspaceIssue landing error result = (%#v, %v)", result, err)
	}
	if _, err = runWorkspaceIssue(&incur.CommandContext{Args: map[string]any{"number": "9"}, Options: map[string]any{"repo": "bad"}}); err == nil {
		t.Fatal("runWorkspaceIssue accepted bad repo")
	}
}
