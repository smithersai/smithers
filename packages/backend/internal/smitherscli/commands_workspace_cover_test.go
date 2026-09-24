package smitherscli

import (
	"bytes"
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

	incur "github.com/smithersai/incur"
)

func commandsWorkspaceCovSetAuthConfig(t *testing.T, apiURL string) {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_TOKEN", "commands_workspace_cov_token")
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commandsWorkspaceCovInstallFakeSSH(t *testing.T) string {
	t.Helper()
	binDir := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
log=${COMMANDS_WORKSPACE_COV_SSH_LOG:-}
if [ -n "$log" ]; then
  printf 'ARGS:%s\n' "$*" >> "$log"
fi
if [ -n "${COMMANDS_WORKSPACE_COV_SSH_EXIT:-}" ]; then
  exit "$COMMANDS_WORKSPACE_COV_SSH_EXIT"
fi
last=""
for arg in "$@"; do
  last="$arg"
done
case "$last" in
  *stream-exit-5*) printf 'streamed failed\n'; exit 5 ;;
  *stream-sleep*) sleep 2; exit 0 ;;
  *stream-ok*) printf 'streamed ok\n'; exit 0 ;;
esac
if [ -t 0 ]; then
  exit 0
fi
stdin=$(cat)
if [ -n "$log" ]; then
  printf 'STDIN_BEGIN\n%s\nSTDIN_END\n' "$stdin" >> "$log"
fi
begin=$(printf '%s' "$stdin" | grep -o '__SMITHERS_BEGIN_[A-Za-z0-9_]*__' | head -n 1)
end=$(printf '%s' "$stdin" | grep -o '__SMITHERS_END_[A-Za-z0-9_]*__' | head -n 1)
if [ -z "$begin" ]; then
  exit 0
fi
status=0
output='ran remote'
if printf '%s' "$stdin" | grep -q 'fail-cov'; then
  status=7
  output='remote failed'
fi
if printf '%s' "$stdin" | grep -q 'jj log'; then
  output='chg1
chg2'
fi
if printf '%s' "$stdin" | grep -q 'claude_processes'; then
  output='diagnostic details'
fi
if [ "${COMMANDS_WORKSPACE_COV_FAIL_CLAUDE:-}" = "1" ] && printf '%s' "$stdin" | grep -q 'claude -p'; then
  status=3
  output='claude failed'
fi
if printf '%s' "$stdin" | grep -q 'printf ready'; then
  output='ready'
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

func TestCommandsWorkspace_Cov_CommandWrappersViewsAndParsing(t *testing.T) {
	var help bytes.Buffer
	if err := workspaceCommand().ServeWithOptions([]string{"--help"}, incur.ServeOptions{Stdout: &help}); err != nil {
		t.Fatalf("workspace help returned error: %v", err)
	}
	for _, want := range []string{"Manage cloud workspaces", "exec", "issue"} {
		if !strings.Contains(help.String(), want) {
			t.Fatalf("workspace help missing %q:\n%s", want, help.String())
		}
	}

	def := workspaceIDCommand("cov wrapper", func(owner, repo, id string, ctx *incur.CommandContext) (any, error) {
		return map[string]any{"owner": owner, "repo": repo, "id": id}, nil
	})
	out, err := def.Handler(&incur.CommandContext{Args: map[string]any{"id": "ws-1"}, Options: map[string]any{"repo": "alice/demo"}})
	if err != nil || objectValue(out)["owner"] != "alice" || objectValue(out)["id"] != "ws-1" {
		t.Fatalf("workspaceIDCommand handler = (%#v, %v)", out, err)
	}
	def = workspaceIDCommandWithOptions("cov wrapper extra", map[string]*incur.JSONSchema{"mode": stringSchema("Mode")}, func(owner, repo, id string, ctx *incur.CommandContext) (any, error) {
		return map[string]any{"mode": stringValue(ctx.Options["mode"]), "repo": owner + "/" + repo, "id": id}, nil
	})
	out, err = def.Handler(&incur.CommandContext{Args: map[string]any{"id": "ws-2"}, Options: map[string]any{"repo": "alice/demo", "mode": "fast"}})
	if err != nil || objectValue(out)["mode"] != "fast" || objectValue(out)["repo"] != "alice/demo" {
		t.Fatalf("workspaceIDCommandWithOptions handler = (%#v, %v)", out, err)
	}

	if got := getWorkspaceSSHCommand(map[string]any{"command": " ssh direct "}); got != "ssh direct" {
		t.Fatalf("getWorkspaceSSHCommand command = %q", got)
	}
	if got := getWorkspaceSSHCommand(map[string]any{"ssh_command": " ssh fallback "}); got != "ssh fallback" {
		t.Fatalf("getWorkspaceSSHCommand ssh_command = %q", got)
	}
	sshView := objectValue(workspaceSSHView(map[string]any{"ssh_host": "workspace.example"}, map[string]any{"ssh_host": "ssh.example", "port": float64(2222), "username": "dev"}))
	if sshView["command"] != "ssh ssh.example" || intValue(sshView["port"], 0) != 2222 {
		t.Fatalf("workspaceSSHView with ssh info = %#v", sshView)
	}
	sshView = objectValue(workspaceSSHView(map[string]any{"ssh_host": "workspace.example"}, nil))
	if sshView["command"] != "ssh workspace.example" {
		t.Fatalf("workspaceSSHView workspace fallback = %#v", sshView)
	}
	if workspaceSSHView(map[string]any{}, nil) != nil {
		t.Fatal("workspaceSSHView without host should return nil")
	}

	running := map[string]any{"status": "running", "created_at": time.Now().Add(-75 * time.Minute).Format(time.RFC3339Nano)}
	if got := stringValue(workspaceUptime(running)); !strings.Contains(got, "1h") {
		t.Fatalf("workspaceUptime running = %#v", got)
	}
	running["suspended_at"] = time.Now().Add(-10 * time.Minute).Format(time.RFC3339Nano)
	running["updated_at"] = time.Now().Add(-2 * time.Minute).Format(time.RFC3339Nano)
	if got := stringValue(workspaceUptime(running)); !strings.Contains(got, "2m") && !strings.Contains(got, "1m") {
		t.Fatalf("workspaceUptime resumed = %#v", got)
	}
	if workspaceUptime(map[string]any{"status": "stopped", "created_at": time.Now().Format(time.RFC3339Nano)}) != nil {
		t.Fatal("workspaceUptime should be nil for stopped workspace")
	}
	if workspaceUptime(map[string]any{"status": "running", "created_at": "not-time"}) != nil {
		t.Fatal("workspaceUptime should be nil for invalid timestamp")
	}

	t.Setenv("COMMANDS_WORKSPACE_COV_DURATION", "25")
	if got := parsePositiveDurationEnv("COMMANDS_WORKSPACE_COV_DURATION", time.Second); got != 25*time.Millisecond {
		t.Fatalf("parsePositiveDurationEnv parsed = %s", got)
	}
	t.Setenv("COMMANDS_WORKSPACE_COV_DURATION", "-1")
	if got := parsePositiveDurationEnv("COMMANDS_WORKSPACE_COV_DURATION", time.Second); got != time.Second {
		t.Fatalf("parsePositiveDurationEnv fallback = %s", got)
	}
	for _, status := range []int{404, 409, 423, 425, 429, 502, 503, 504} {
		if !shouldRetryWorkspaceSSHError(&APIError{Status: status}) {
			t.Fatalf("status %d should be retried", status)
		}
	}
	if shouldRetryWorkspaceSSHError(&APIError{Status: http.StatusForbidden}) {
		t.Fatal("403 should not be retried")
	}
	if !shouldRetryWorkspaceSSHError(fmt.Errorf("temporary network error")) {
		t.Fatal("non-API errors should be retried")
	}

	tokens := tokenizeShellWords(`ssh -i '/tmp/key with space' "dev@example.com" escaped\ value`)
	wantTokens := []string{"ssh", "-i", "/tmp/key with space", "dev@example.com", "escaped value"}
	if !reflect.DeepEqual(tokens, wantTokens) {
		t.Fatalf("tokenizeShellWords = %#v, want %#v", tokens, wantTokens)
	}
	t.Setenv("SMITHERS_WORKSPACE_KNOWN_HOSTS_FILE", filepath.Join(t.TempDir(), "ssh", "known_hosts"))
	if got := workspaceKnownHostsFile(); !strings.HasSuffix(got, "known_hosts") {
		t.Fatalf("workspaceKnownHostsFile = %q", got)
	}
	if cols, rows := terminalSize(88, 33); cols != 88 || rows != 33 {
		t.Fatalf("terminalSize explicit = (%d, %d)", cols, rows)
	}
}

func TestCommandsWorkspace_Cov_ScriptBuildersAuthAndExtraction(t *testing.T) {
	bootstrap := buildWorkspaceBootstrapScript()
	if !strings.Contains(bootstrap, "jj git init") || !strings.Contains(bootstrap, defaultWorkspaceRemoteRoot) {
		t.Fatalf("buildWorkspaceBootstrapScript = %s", bootstrap)
	}
	nodeBootstrap := buildWorkspaceNodeBootstrapScript()
	if !strings.Contains(nodeBootstrap, defaultRemoteLocalBinDir) || !strings.Contains(nodeBootstrap, "node") {
		t.Fatalf("buildWorkspaceNodeBootstrapScript = %s", nodeBootstrap)
	}
	claudeSeed := buildClaudeAuthSeedRemoteScript(map[string]string{"B_TOKEN": "two", "A_TOKEN": "one's"})
	if !strings.Contains(claudeSeed, "export A_TOKEN") || !strings.Contains(claudeSeed, "one") || !strings.Contains(claudeSeed, "s") || strings.Index(claudeSeed, "A_TOKEN") > strings.Index(claudeSeed, "B_TOKEN") {
		t.Fatalf("buildClaudeAuthSeedRemoteScript did not sort/escape exports:\n%s", claudeSeed)
	}
	claudeRemote := buildClaudeRemoteScript("Fix the thing")
	if !strings.Contains(claudeRemote, defaultClaudeCodePackage) || !strings.Contains(claudeRemote, "claude -p") || strings.Contains(claudeRemote, "Fix the thing") {
		t.Fatalf("buildClaudeRemoteScript did not include expected install/encoded prompt behavior:\n%s", claudeRemote)
	}
	if diagnostics := buildClaudeDiagnosticsRemoteScript(); !strings.Contains(diagnostics, "claude_processes") || !strings.Contains(diagnostics, defaultRemoteClaudeInstallLog) {
		t.Fatalf("buildClaudeDiagnosticsRemoteScript = %s", diagnostics)
	}
	if changeScript := buildChangeIDListRemoteScript(`release"v1`); !strings.Contains(changeScript, `release\"v1`) || !strings.Contains(changeScript, "jj log") {
		t.Fatalf("buildChangeIDListRemoteScript = %s", changeScript)
	}

	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	setTestClaudeKeychainPayload(t, `not-json`)
	if env := getClaudeAuthEnv(); env != nil {
		t.Fatalf("getClaudeAuthEnv invalid keychain payload = %#v", env)
	}
	future := time.Now().Add(time.Hour).UnixMilli()
	var payload claudeCodeKeychainPayload
	payload.ClaudeAIOAuth.AccessToken = "oauth-token"
	payload.ClaudeAIOAuth.ExpiresAt = future
	if got := claudeKeychainAccessToken(payload); got != "oauth-token" {
		t.Fatalf("claudeKeychainAccessToken future = %q", got)
	}
	payload.ClaudeAIOAuth.ExpiresAt = 1
	if got := claudeKeychainAccessToken(payload); got != "" {
		t.Fatalf("claudeKeychainAccessToken expired = %q", got)
	}
	setTestClaudeKeychainPayload(t, fmt.Sprintf(`{"claudeAiOauth":{"accessToken":"oauth-token","expiresAt":%d}}`, future))
	if got := loadClaudeOAuthAccessTokenFromKeychain(); got != "oauth-token" {
		t.Fatalf("loadClaudeOAuthAccessTokenFromKeychain test payload = %q", got)
	}

	setTestCodexAuthJSON(t, `{"tokens":{"id_token":"from-env"}}`)
	if raw := readLocalCodexAuthFile(); !strings.Contains(raw, "from-env") {
		t.Fatalf("readLocalCodexAuthFile env = %q", raw)
	}
	content, ok := getCodexAuthContent()
	if !ok || !strings.Contains(content, "from-env") {
		t.Fatalf("getCodexAuthContent env = (%q, %t)", content, ok)
	}
	setTestCodexAuthJSON(t, "")
	t.Setenv("OPENAI_API_KEY", "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "auth.json"), []byte(" {\"token\":\"from-file\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if raw := readLocalCodexAuthFile(); raw != `{"token":"from-file"}` {
		t.Fatalf("readLocalCodexAuthFile file = %q", raw)
	}

	marker := randomMarkerID()
	if marker == "" {
		t.Fatal("randomMarkerID returned empty marker")
	}
	session := buildRemoteShellSessionScript("__BEGIN__", "__END__", "echo hi")
	if !strings.Contains(session, "__BEGIN__") || !strings.Contains(session, "__END__:%s") {
		t.Fatalf("buildRemoteShellSessionScript = %s", session)
	}
	raw := "\x1b[31mnoise\x1b[0m\r\n__BEGIN__\nhello\n\n__END__:7\n"
	exitCode, output := extractRemoteShellOutput(raw, "__BEGIN__", "__END__")
	if exitCode != 7 || output != "hello" {
		t.Fatalf("extractRemoteShellOutput = (%d, %q)", exitCode, output)
	}
	exitCode, output = extractRemoteShellOutput("no markers\x1b[0m\r", "__BEGIN__", "__END__")
	if exitCode != -1 || output != "no markers" {
		t.Fatalf("extractRemoteShellOutput missing marker = (%d, %q)", exitCode, output)
	}
	if got := stripANSI("\x1b[32mgreen\x1b[0m\r\n"); got != "green\n" {
		t.Fatalf("stripANSI = %q", got)
	}
	t.Setenv("COMMANDS_WORKSPACE_COV_TIMEOUT_MS", "15")
	if got := remoteShellTimeout("COMMANDS_WORKSPACE_COV_TIMEOUT_MS", time.Second); got != 15*time.Millisecond {
		t.Fatalf("remoteShellTimeout = %s", got)
	}
	values := []string{"b", "a", "c"}
	sortStrings(values)
	if !reflect.DeepEqual(values, []string{"a", "b", "c"}) {
		t.Fatalf("sortStrings = %#v", values)
	}
}

func TestCommandsWorkspace_Cov_HTTPWorkspaceFlows(t *testing.T) {
	sshCommand := commandsWorkspaceCovInstallFakeSSH(t)
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "anthropic-cov-token")
	t.Setenv("SMITHERS_WORKSPACE_SSH_POLL_INTERVAL_MS", "1")
	t.Setenv("SMITHERS_WORKSPACE_SSH_POLL_TIMEOUT_MS", "80")
	sshPolls := 0
	var landingBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "token commands_workspace_cov_token" {
			t.Errorf("Authorization header = %q for %s", got, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces":
			fmt.Fprint(w, `[{"id":"ws-run","status":"running"}]`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/workspaces":
			fmt.Fprint(w, `{"id":"ws-new"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-poll/ssh":
			sshPolls++
			if sshPolls == 1 {
				w.WriteHeader(http.StatusNotFound)
				fmt.Fprint(w, `{"message":"not ready"}`)
				return
			}
			fmt.Fprintf(w, `{"command":%q}`, sshCommand)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-new/ssh":
			fmt.Fprintf(w, `{"command":%q}`, sshCommand)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-denied/ssh":
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprint(w, `{"message":"denied"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-stream/stream":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "id: 1\nevent: status\ndata: {\"status\":\"deleted\"}\n\n")
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/issues/7":
			fmt.Fprint(w, `{"number":7,"title":"Broken thing","body":"Steps","labels":[{"name":"bug"}]}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/landings":
			if err := json.NewDecoder(r.Body).Decode(&landingBody); err != nil {
				t.Errorf("invalid landing body: %v", err)
			}
			fmt.Fprint(w, `{"number":55}`)
		default:
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		}
	}))
	defer server.Close()
	commandsWorkspaceCovSetAuthConfig(t, server.URL)

	ctx := &incur.CommandContext{Args: map[string]any{"id": "explicit"}, Options: map[string]any{"repo": "alice/demo"}}
	owner, repo, workspaceID, err := resolveWorkspaceID(ctx)
	if err != nil || owner != "alice" || repo != "demo" || workspaceID != "explicit" {
		t.Fatalf("resolveWorkspaceID explicit = (%q, %q, %q, %v)", owner, repo, workspaceID, err)
	}
	ctx.Args = map[string]any{}
	owner, repo, workspaceID, err = resolveWorkspaceID(ctx)
	if err != nil || workspaceID != "ws-run" {
		t.Fatalf("resolveWorkspaceID detected = (%q, %q, %q, %v)", owner, repo, workspaceID, err)
	}

	sshInfo, err := waitForWorkspaceSSHInfo("alice", "demo", "ws-poll")
	if err != nil || getWorkspaceSSHCommand(sshInfo) != sshCommand || sshPolls != 2 {
		t.Fatalf("waitForWorkspaceSSHInfo = (%#v, %v), polls=%d", sshInfo, err, sshPolls)
	}
	if _, err = waitForWorkspaceSSHInfo("alice", "demo", "ws-denied"); err == nil || !strings.Contains(err.Error(), "denied") {
		t.Fatalf("waitForWorkspaceSSHInfo denied = %v", err)
	}

	events, err := streamWorkspaceEvents("alice", "demo", "ws-stream")
	if err != nil || len(events) != 1 || events[0]["id"] != "1" {
		t.Fatalf("streamWorkspaceEvents = (%#v, %v)", events, err)
	}
	if err = runWorkspaceTerminal("alice", "demo", "sess-1", 80, 24); err == nil {
		t.Fatal("runWorkspaceTerminal should fail against non-websocket test server")
	}

	result, err := runWorkspaceIssue(&incur.CommandContext{
		Args:    map[string]any{"number": "7"},
		Options: map[string]any{"repo": "alice/demo", "target": "main"},
	})
	if err != nil {
		t.Fatalf("runWorkspaceIssue returned error: %v", err)
	}
	record := objectValue(result)
	changeIDs, _ := record["change_ids"].([]string)
	if record["workspace_id"] != "ws-new" || intValue(record["landing_request"], 0) != 55 || len(changeIDs) != 2 {
		t.Fatalf("runWorkspaceIssue result = %#v", record)
	}
	if landingBody["target_bookmark"] != "main" || len(arrayValue(landingBody["change_ids"])) != 2 {
		t.Fatalf("landing body = %#v", landingBody)
	}
	if _, err = runWorkspaceIssue(&incur.CommandContext{Args: map[string]any{"number": "nope"}, Options: map[string]any{"repo": "alice/demo"}}); err == nil || !strings.Contains(err.Error(), "invalid issue number") {
		t.Fatalf("runWorkspaceIssue invalid number = %v", err)
	}
}

func TestCommandsWorkspace_Cov_RemoteShellAndAgentAuth(t *testing.T) {
	sshCommand := commandsWorkspaceCovInstallFakeSSH(t)
	t.Setenv("SMITHERS_WORKSPACE_REMOTE_COMMAND_TIMEOUT_MS", "5000")
	t.Setenv("SMITHERS_WORKSPACE_CLAUDE_TIMEOUT_MS", "5000")

	if err := runSSHCommand(""); err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("runSSHCommand empty = %v", err)
	}
	out, err := runRemoteCaptureCommand(sshCommand, "echo capture", "capture")
	if err != nil || strings.TrimSpace(out) != "ran remote" {
		t.Fatalf("runRemoteCaptureCommand = (%q, %v)", out, err)
	}
	if err := runRemoteProvisionCommand(sshCommand, "echo provision", "provision"); err != nil {
		t.Fatalf("runRemoteProvisionCommand returned error: %v", err)
	}
	if err := runRemoteInteractiveCommand(sshCommand, "echo interactive", "interactive"); err != nil {
		t.Fatalf("runRemoteInteractiveCommand returned error: %v", err)
	}
	if _, err = runRemoteShellCommand(sshCommand, "fail-cov", "failure", false, time.Second); err == nil || !strings.Contains(err.Error(), "remote failed") {
		t.Fatalf("runRemoteShellCommand failure = %v", err)
	}
	code, err := runRemoteStreamedCommand(sshCommand, "stream-ok", time.Second)
	if err != nil || code != 0 {
		t.Fatalf("runRemoteStreamedCommand success = (%d, %v)", code, err)
	}
	code, err = runRemoteStreamedCommand(sshCommand, "stream-exit-5", time.Second)
	if err != nil || code != 5 {
		t.Fatalf("runRemoteStreamedCommand nonzero = (%d, %v)", code, err)
	}
	if _, err = runRemoteStreamedCommand(sshCommand, "stream-sleep", 20*time.Millisecond); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("runRemoteStreamedCommand timeout = %v", err)
	}

	t.Setenv("ANTHROPIC_AUTH_TOKEN", "anthropic-cov-token")
	t.Setenv("OPENAI_API_KEY", "openai-cov-token")
	setTestCodexAuthJSON(t, "")
	if err := seedWorkspaceAgentAuth(sshCommand, []string{"claude", "codex"}); err != nil {
		t.Fatalf("seedWorkspaceAgentAuth returned error: %v", err)
	}
	if err := ensureWorkspaceClaudeAuth(sshCommand); err != nil {
		t.Fatalf("ensureWorkspaceClaudeAuth with local auth returned error: %v", err)
	}

	ids, err := listWorkspaceChangeIDs(sshCommand, "main")
	if err != nil || !reflect.DeepEqual(ids, []string{"chg1", "chg2"}) {
		t.Fatalf("listWorkspaceChangeIDs = (%#v, %v)", ids, err)
	}
	if err := runWorkspaceClaudeCommand(sshCommand, "prompt"); err != nil {
		t.Fatalf("runWorkspaceClaudeCommand success returned error: %v", err)
	}
}

func TestCommandsWorkspace_Cov_RemoteClaudeFailureAndRemoteAuthCheck(t *testing.T) {
	sshCommand := commandsWorkspaceCovInstallFakeSSH(t)
	t.Setenv("SMITHERS_WORKSPACE_REMOTE_COMMAND_TIMEOUT_MS", "5000")
	t.Setenv("SMITHERS_WORKSPACE_CLAUDE_TIMEOUT_MS", "5000")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	setTestClaudeKeychainPayload(t, `not-json`)
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")

	if err := ensureWorkspaceClaudeAuth(sshCommand); err != nil {
		t.Fatalf("ensureWorkspaceClaudeAuth remote-ready check returned error: %v", err)
	}

	t.Setenv("COMMANDS_WORKSPACE_COV_FAIL_CLAUDE", "1")
	err := runWorkspaceClaudeCommand(sshCommand, "prompt")
	if err == nil || !strings.Contains(err.Error(), "Workspace diagnostics") || !strings.Contains(err.Error(), "diagnostic details") {
		t.Fatalf("runWorkspaceClaudeCommand failure = %v", err)
	}
}
