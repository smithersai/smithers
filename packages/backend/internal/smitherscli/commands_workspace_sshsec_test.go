package smitherscli

import (
	"strings"
	"testing"
)

// The workspace SSH command string comes from the server
// (GET /api/repos/{owner}/{repo}/workspaces/{id}/ssh). buildSSHInvocationArgs
// already pins the executable to ssh, but any additional tokens are passed to
// the ssh child verbatim. ssh options such as ProxyCommand and
// PermitLocalCommand+LocalCommand run LOCAL commands, so a malicious or
// compromised server response would otherwise execute code on the developer's
// machine — far beyond the command's designed function (opening an SSH
// session to the workspace VM).
func TestBuildSSHInvocationArgsRejectsLocalCommandExecutionOptions(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_KNOWN_HOSTS_FILE", t.TempDir()+"/known_hosts")

	cases := []struct {
		name    string
		command string
	}{
		{"proxy command split form", "ssh -o ProxyCommand=/bin/false developer@example.com"},
		{"proxy command joined form", "ssh -oProxyCommand=/bin/false developer@example.com"},
		{"proxy command case insensitive", "ssh -o proxycOMMAND=/bin/false developer@example.com"},
		{"local command", "ssh -o LocalCommand=/bin/false developer@example.com"},
		{"leading whitespace", "ssh -o ' ProxyCommand=/bin/false' developer@example.com"},
		{"combined short options", "ssh -voProxyCommand=/bin/false developer@example.com"},
		{"config file", "ssh -F /tmp/hostile-config developer@example.com"},
		{"include config", "ssh -o Include=/tmp/hostile-config developer@example.com"},
		{"known hosts command", "ssh -o KnownHostsCommand=/bin/false developer@example.com"},
		{"provider library", "ssh -I /tmp/provider.so developer@example.com"},
		{"security key library", "ssh -o SecurityKeyProvider=/tmp/provider.so developer@example.com"},
		{"proxy jump", "ssh -J proxy.example developer@example.com"},
		{"log file overwrite", "ssh -E /tmp/target developer@example.com"},
		{"malformed option", "ssh -o"},
		{"permit local command", "ssh -o PermitLocalCommand=yes -o LocalCommand=/bin/false developer@example.com"},
		{"proxy command as destination-looking token", "ssh developer@example.com -o ProxyCommand=/bin/false"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			args, err := buildSSHInvocationArgs(tc.command, false)
			if err == nil {
				t.Fatalf("buildSSHInvocationArgs(%q) = %v, want rejection of local-command-executing ssh option", tc.command, args)
			}
		})
	}
}

func TestBuildSSHInvocationArgsAllowsBenignServerOptions(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_KNOWN_HOSTS_FILE", t.TempDir()+"/known_hosts")

	args, err := buildSSHInvocationArgs("ssh -p 2222 -o ServerAliveInterval=30 -i /tmp/key developer@example.com", false)
	if err != nil {
		t.Fatalf("buildSSHInvocationArgs rejected a benign server command: %v", err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{"-p 2222", "ServerAliveInterval=30", "-i /tmp/key", "developer@example.com"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("buildSSHInvocationArgs dropped benign token %q: %v", want, args)
		}
	}
}

func TestBuildSSHInvocationArgsAllowsTokenizedWorkspaceDestination(t *testing.T) {
	_, err := buildSSHInvocationArgs("ssh vm-123+developer:workspace_token-123@ssh.example.com", false)
	if err != nil {
		t.Fatal(err)
	}
}
