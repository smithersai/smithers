package smitherscli

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestNormalizeWorkspaceExecOptions(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name           string
		command        string
		timeoutSeconds int
		wantCommand    string
		wantTimeout    time.Duration
		wantErr        string
	}{
		{
			name:        "missing command",
			command:     "",
			wantTimeout: 0,
			wantErr:     "--command is required",
		},
		{
			name:        "blank command",
			command:     " \t\n ",
			wantTimeout: 0,
			wantErr:     "--command is required",
		},
		{
			name:        "trims command and uses default timeout",
			command:     " echo hi ",
			wantCommand: "echo hi",
			wantTimeout: defaultWorkspaceRemoteCommandTimeout,
		},
		{
			name:           "positive timeout",
			command:        "node --version",
			timeoutSeconds: 7,
			wantCommand:    "node --version",
			wantTimeout:    7 * time.Second,
		},
		{
			name:           "non-positive timeout falls back",
			command:        "pwd",
			timeoutSeconds: -1,
			wantCommand:    "pwd",
			wantTimeout:    defaultWorkspaceRemoteCommandTimeout,
		},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			gotCommand, gotTimeout, err := normalizeWorkspaceExecOptions(tc.command, tc.timeoutSeconds)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("expected error containing %q, got %v", tc.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if gotCommand != tc.wantCommand || gotTimeout != tc.wantTimeout {
				t.Fatalf("normalizeWorkspaceExecOptions() = (%q, %s), want (%q, %s)", gotCommand, gotTimeout, tc.wantCommand, tc.wantTimeout)
			}
		})
	}
}

func TestBuildWorkspaceExecRemoteScript(t *testing.T) {
	if got := buildWorkspaceExecRemoteScript("pwd"); got != "cd '/home/developer/workspace' && pwd" {
		t.Fatalf("buildWorkspaceExecRemoteScript(pwd) = %q", got)
	}
	compound := "pwd && printf '%s\\n' ready; exit 7"
	if got := buildWorkspaceExecRemoteScript(compound); got != "cd '/home/developer/workspace' && "+compound {
		t.Fatalf("buildWorkspaceExecRemoteScript(compound) = %q", got)
	}
}

func TestBuildSSHInvocationArgs(t *testing.T) {
	knownHosts := filepath.Join(t.TempDir(), "known_hosts")
	t.Setenv("SMITHERS_WORKSPACE_KNOWN_HOSTS_FILE", knownHosts)
	t.Setenv("SMITHERS_WORKSPACE_SSH_CONNECT_TIMEOUT_SECONDS", "9")

	cases := []struct {
		name       string
		command    string
		forceTTY   bool
		want       []string
		wantPrefix []string
		wantErr    string
	}{
		{
			name:    "empty",
			command: "",
			want:    nil,
		},
		{
			name:     "adds non interactive workspace ssh options",
			command:  "ssh -i '/tmp/key with space' developer@example.com",
			forceTTY: false,
			want: []string{
				"ssh",
				"-o", "BatchMode=yes",
				"-o", "ConnectTimeout=9",
				"-o", "StrictHostKeyChecking=accept-new",
				"-o", "UserKnownHostsFile=" + knownHosts,
				"-o", "LogLevel=ERROR",
				"-i", "/tmp/key with space", "developer@example.com",
			},
		},
		{
			name:       "force tty inserts tt before options",
			command:    "ssh developer@example.com",
			forceTTY:   true,
			wantPrefix: []string{"ssh", "-tt", "-o", "BatchMode=yes"},
		},
		{
			name:    "non ssh command is rejected",
			command: "plink developer@example.com",
			wantErr: "executable must be ssh",
		},
		{
			name:    "ssh path is rejected",
			command: filepath.Join(t.TempDir(), "ssh") + " developer@example.com",
			wantErr: "executable must be ssh",
		},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got, err := buildSSHInvocationArgs(tc.command, tc.forceTTY)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("buildSSHInvocationArgs() error = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("buildSSHInvocationArgs() unexpected error = %v", err)
			}
			if tc.wantPrefix != nil {
				if len(got) < len(tc.wantPrefix) || !reflect.DeepEqual(got[:len(tc.wantPrefix)], tc.wantPrefix) {
					t.Fatalf("buildSSHInvocationArgs() prefix = %v, want %v (full: %v)", got[:min(len(got), len(tc.wantPrefix))], tc.wantPrefix, got)
				}
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("buildSSHInvocationArgs() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestRunSSHCommandRejectsNonSSHExecutable(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "executed")
	err := runSSHCommand(fmt.Sprintf("sh -c %s", shellEscape("touch "+marker)))
	if err == nil || !strings.Contains(err.Error(), "executable must be ssh") {
		t.Fatalf("runSSHCommand() error = %v, want non-ssh executable rejection", err)
	}
	if _, statErr := os.Stat(marker); !os.IsNotExist(statErr) {
		t.Fatalf("non-ssh command was executed; marker stat error = %v", statErr)
	}
}

func TestParseSeedAgentAuthList(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{name: "empty", in: "", want: []string{}},
		{name: "single", in: "claude", want: []string{"claude"}},
		{name: "comma separated", in: "claude,codex", want: []string{"claude", "codex"}},
		{name: "whitespace and case", in: " Claude , CODEX ", want: []string{"claude", "codex"}},
		{name: "dedupes", in: "claude,claude,codex", want: []string{"claude", "codex"}},
		{name: "ignores empty segments", in: "claude,,codex,", want: []string{"claude", "codex"}},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := parseSeedAgentAuthList(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("parseSeedAgentAuthList(%q) = %v, want %v", tc.in, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("parseSeedAgentAuthList(%q) = %v, want %v", tc.in, got, tc.want)
				}
			}
		})
	}
}

func TestSeedWorkspaceAgentAuth_UnknownAgent(t *testing.T) {
	t.Parallel()
	err := seedWorkspaceAgentAuth("ssh fake-host", []string{"unknown-agent"})
	if err == nil {
		t.Fatal("expected an error for an unknown agent")
	}
	if !strings.Contains(err.Error(), "unknown-agent") {
		t.Fatalf("expected error to mention the unknown agent, got: %v", err)
	}
}

func TestSeedWorkspaceAgentAuth_ClaudeMissingLocalAuth(t *testing.T) {
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	setTestClaudeKeychainPayload(t, "")
	t.Setenv("HOME", t.TempDir())
	err := seedWorkspaceAgentAuth("ssh fake-host", []string{"claude"})
	if err == nil {
		t.Fatal("expected an error when no local Claude auth is available")
	}
}

func TestSeedWorkspaceAgentAuth_CodexMissingLocalAuth(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	setTestCodexAuthJSON(t, "")
	t.Setenv("HOME", t.TempDir())
	err := seedWorkspaceAgentAuth("ssh fake-host", []string{"codex"})
	if err == nil {
		t.Fatal("expected an error when no local Codex auth is available")
	}
}

func TestGetClaudeAuthEnv_PrefersKeychainOAuthOverAPIKey(t *testing.T) {
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_API_KEY", "sk-fake-api-key-for-test")
	setTestClaudeKeychainPayload(t, `{"claudeAiOauth":{"accessToken":"sk-fake-oauth-token-for-test"}}`)
	t.Setenv("HOME", t.TempDir())

	env := getClaudeAuthEnv()
	if env["ANTHROPIC_API_KEY"] != "" {
		t.Fatalf("expected ANTHROPIC_API_KEY to not be used when keychain OAuth is available, got env: %v", env)
	}
	if env["ANTHROPIC_AUTH_TOKEN"] != "sk-fake-oauth-token-for-test" {
		t.Fatalf("expected ANTHROPIC_AUTH_TOKEN to come from keychain OAuth, got env: %v", env)
	}
}

func TestGetClaudeAuthEnv_ExpiredKeychainOAuthFallsBackToAPIKey(t *testing.T) {
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_API_KEY", "sk-fake-api-key-for-test")
	// expiresAt in the past (epoch millis) — the keychain token is dead.
	setTestClaudeKeychainPayload(t, `{"claudeAiOauth":{"accessToken":"sk-fake-oauth-token-for-test","expiresAt":1}}`)
	t.Setenv("HOME", t.TempDir())

	env := getClaudeAuthEnv()
	if env["ANTHROPIC_AUTH_TOKEN"] != "" {
		t.Fatalf("expired keychain OAuth token must not be seeded, got env: %v", env)
	}
	if env["ANTHROPIC_API_KEY"] != "sk-fake-api-key-for-test" {
		t.Fatalf("expected fallback to ANTHROPIC_API_KEY, got env: %v", env)
	}
}

func TestGetClaudeAuthEnv_UnexpiredKeychainOAuthStillWins(t *testing.T) {
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_API_KEY", "sk-fake-api-key-for-test")
	future := time.Now().Add(time.Hour).UnixMilli()
	setTestClaudeKeychainPayload(t, fmt.Sprintf(`{"claudeAiOauth":{"accessToken":"sk-fake-oauth-token-for-test","expiresAt":%d}}`, future))
	t.Setenv("HOME", t.TempDir())

	env := getClaudeAuthEnv()
	if env["ANTHROPIC_AUTH_TOKEN"] != "sk-fake-oauth-token-for-test" {
		t.Fatalf("a still-valid keychain OAuth token must win, got env: %v", env)
	}
	if env["ANTHROPIC_API_KEY"] != "" {
		t.Fatalf("expected keychain OAuth to shadow ANTHROPIC_API_KEY, got env: %v", env)
	}
}

func TestGetClaudeAuthEnv_FallsBackToAPIKeyWhenNoKeychainOAuth(t *testing.T) {
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_API_KEY", "sk-fake-api-key-for-test")
	setTestClaudeKeychainPayload(t, "")
	t.Setenv("HOME", t.TempDir())

	env := getClaudeAuthEnv()
	if env["ANTHROPIC_API_KEY"] != "sk-fake-api-key-for-test" {
		t.Fatalf("expected fallback to ANTHROPIC_API_KEY, got env: %v", env)
	}
}

func TestGetClaudeAuthEnv_ExplicitAuthTokenEnvWins(t *testing.T) {
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "sk-fake-explicit-token-for-test")
	t.Setenv("ANTHROPIC_API_KEY", "sk-fake-api-key-for-test")
	setTestClaudeKeychainPayload(t, `{"claudeAiOauth":{"accessToken":"sk-fake-oauth-token-for-test"}}`)
	t.Setenv("HOME", t.TempDir())

	env := getClaudeAuthEnv()
	if env["ANTHROPIC_AUTH_TOKEN"] != "sk-fake-explicit-token-for-test" {
		t.Fatalf("expected explicit ANTHROPIC_AUTH_TOKEN env to take priority, got env: %v", env)
	}
}

func TestGetCodexAuthContent_PrefersLocalAuthFileOverAPIKey(t *testing.T) {
	setTestCodexAuthJSON(t, `{"OPENAI_API_KEY":null,"tokens":{"id_token":"sk-fake-codex-token-for-test"}}`)
	t.Setenv("OPENAI_API_KEY", "sk-fake-should-not-be-used")
	content, ok := getCodexAuthContent()
	if !ok {
		t.Fatal("expected getCodexAuthContent to succeed")
	}
	if !strings.Contains(content, "sk-fake-codex-token-for-test") {
		t.Fatalf("expected content to come from the local auth file, got: %s", content)
	}
}

func TestGetCodexAuthContent_FallsBackToAPIKey(t *testing.T) {
	setTestCodexAuthJSON(t, "")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("OPENAI_API_KEY", "sk-fake-codex-key-for-test")
	content, ok := getCodexAuthContent()
	if !ok {
		t.Fatal("expected getCodexAuthContent to succeed via OPENAI_API_KEY fallback")
	}
	if !strings.Contains(content, "sk-fake-codex-key-for-test") {
		t.Fatalf("expected content to embed OPENAI_API_KEY, got: %s", content)
	}
}

func TestGetCodexAuthContent_NoLocalCredentials(t *testing.T) {
	setTestCodexAuthJSON(t, "")
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("HOME", t.TempDir())
	if _, ok := getCodexAuthContent(); ok {
		t.Fatal("expected getCodexAuthContent to fail with no local credentials")
	}
}

func TestBuildCodexAuthSeedRemoteScript(t *testing.T) {
	t.Parallel()
	script := buildCodexAuthSeedRemoteScript(`{"OPENAI_API_KEY":"sk-fake-codex-key-for-test"}`)
	if !strings.Contains(script, defaultRemoteCodexAuthDir) {
		t.Fatalf("expected script to reference %s, got: %s", defaultRemoteCodexAuthDir, script)
	}
	if !strings.Contains(script, defaultRemoteCodexAuthFile) {
		t.Fatalf("expected script to reference %s, got: %s", defaultRemoteCodexAuthFile, script)
	}
	if !strings.Contains(script, "chmod 600") {
		t.Fatalf("expected script to chmod 600 the auth file, got: %s", script)
	}
	if !strings.Contains(script, "sk-fake-codex-key-for-test") {
		t.Fatalf("expected script to embed the auth content, got: %s", script)
	}
	if !strings.Contains(script, "set -euo pipefail") {
		t.Fatalf("expected script to set -euo pipefail like the Claude auth seed script, got: %s", script)
	}
}

func TestBuildCodexAuthSeedRemoteScript_EscapesShellMetacharacters(t *testing.T) {
	t.Parallel()
	script := buildCodexAuthSeedRemoteScript(`it's "quoted" $(rm -rf /)`)
	// shellEscape wraps the payload in single quotes and escapes embedded
	// single quotes (' -> '\''); the payload should be single-quoted, not
	// interpolated raw where a shell could expand $(...) or the quotes.
	if !strings.Contains(script, `'\''s "quoted" $(rm -rf /)'`) {
		t.Fatalf("expected the payload to be single-quote escaped via shellEscape, got: %s", script)
	}
}

func TestRunRemoteStreamedCommand_EmptySSHCommand(t *testing.T) {
	t.Parallel()
	_, err := runRemoteStreamedCommand("", "echo hi", time.Second)
	if err == nil {
		t.Fatal("expected an error for an empty ssh command")
	}
}
