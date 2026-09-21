package smitherscli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func configCovWriteConfig(t *testing.T, body string) string {
	t.Helper()
	path := ConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestConfig_Cov_BaseDirsAndConfigLifecycle(t *testing.T) {
	configHome := t.TempDir()
	cacheHome := t.TempDir()
	stateHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("XDG_CACHE_HOME", cacheHome)
	t.Setenv("XDG_STATE_HOME", stateHome)
	t.Setenv("SMITHERS_AGENT_ISSUE_REPO", "")
	t.Setenv("SMITHERS_API_ORIGIN", "")

	if got := configBaseDir(); got != configHome {
		t.Fatalf("configBaseDir() = %q, want %q", got, configHome)
	}
	if got := cacheBaseDir(); got != cacheHome {
		t.Fatalf("cacheBaseDir() = %q, want %q", got, cacheHome)
	}
	if got := stateBaseDir(); got != stateHome {
		t.Fatalf("stateBaseDir() = %q, want %q", got, stateHome)
	}
	if got := CacheDir(); got != filepath.Join(cacheHome, "smithers") {
		t.Fatalf("CacheDir() = %q", got)
	}
	if got := StateDir(); got != filepath.Join(stateHome, "smithers") {
		t.Fatalf("StateDir() = %q", got)
	}

	raw := LoadRawConfig()
	if raw.APIURL != defaultAPIURL || raw.GitProtocol != GitProtocolSSH {
		t.Fatalf("missing config defaults = %#v", raw)
	}

	configCovWriteConfig(t, ":\n")
	raw = LoadRawConfig()
	if raw.APIURL != defaultAPIURL || raw.GitProtocol != GitProtocolSSH {
		t.Fatalf("invalid config should return defaults, got %#v", raw)
	}

	configCovWriteConfig(t, strings.Join([]string{
		"api_url: https://api.example.com/api/",
		"git_protocol: https",
		"agent_issue_repo: owners/issues",
		"token: legacy-token",
		"",
	}, "\n"))
	raw = LoadRawConfig()
	if raw.APIURL != "https://api.example.com" || raw.GitProtocol != GitProtocolHTTPS || raw.AgentIssueRepo != "owners/issues" || raw.Token != "legacy-token" {
		t.Fatalf("LoadRawConfig parsed %#v", raw)
	}
	t.Setenv("SMITHERS_AGENT_ISSUE_REPO", "env/issues")
	if got := LoadConfig().AgentIssueRepo; got != "env/issues" {
		t.Fatalf("LoadConfig env override = %q", got)
	}
	t.Setenv("SMITHERS_API_ORIGIN", "http://127.0.0.1:9090/api/")
	if got := LoadConfig().APIURL; got != "http://127.0.0.1:9090" {
		t.Fatalf("LoadConfig API origin override = %q", got)
	}
	t.Setenv("SMITHERS_API_ORIGIN", "")

	if err := SaveConfig(map[string]string{"api_url": " http://localhost:8080/api/ ", "git_protocol": "ssh", "agent_issue_repo": "new/issues"}); err != nil {
		t.Fatalf("SaveConfig returned error: %v", err)
	}
	raw = LoadRawConfig()
	if raw.APIURL != "http://localhost:8080" || raw.GitProtocol != GitProtocolSSH || raw.AgentIssueRepo != "new/issues" {
		t.Fatalf("SaveConfig merged %#v", raw)
	}

	cleared, err := ClearLegacyToken()
	if err != nil {
		t.Fatalf("ClearLegacyToken without token returned error: %v", err)
	}
	if cleared {
		t.Fatal("ClearLegacyToken should report false when no legacy token is present")
	}
	configCovWriteConfig(t, "api_url: https://api.example.com\ntoken: old\n")
	cleared, err = ClearLegacyToken()
	if err != nil || !cleared {
		t.Fatalf("ClearLegacyToken with token = (%t, %v)", cleared, err)
	}
	if token := LoadRawConfig().Token; token != "" {
		t.Fatalf("legacy token was not cleared: %q", token)
	}
}

func TestConfig_Cov_NormalizeAndHostBranches(t *testing.T) {
	if got := normalizeAPIURL(" https://api.example.com/api/ "); got != "https://api.example.com" {
		t.Fatalf("normalizeAPIURL trimmed API suffix = %q", got)
	}
	if got := normalizeAPIURL("https://example.com/v1/"); got != "https://example.com/v1" {
		t.Fatalf("normalizeAPIURL preserved non-api path = %q", got)
	}

	cases := []struct {
		in   string
		want string
	}{
		{"https://user:pass@api.Example.com:8443/path", "example.com"},
		{"api.smithers.sh", "smithers.sh"},
		{"https://[::1]:8080/api", "[::1]"},
		{"localhost:3000", "localhost:3000"},
	}
	for _, tc := range cases {
		if got := hostFromURL(tc.in); got != tc.want {
			t.Fatalf("hostFromURL(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestConfig_Cov_DarwinDefaultDirs(t *testing.T) {
	// configBaseDir and friends branch on cliGOOS, not on the build target, so
	// pin it: without this the test only asserted macOS layout when it happened
	// to run on macOS, and Cloud CI (linux) failed it in run 11748.
	previousGOOS := cliGOOS
	cliGOOS = "darwin"
	t.Cleanup(func() { cliGOOS = previousGOOS })

	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_CACHE_HOME", "")
	t.Setenv("XDG_STATE_HOME", "")
	home := t.TempDir()
	t.Setenv("HOME", home)

	if got := configBaseDir(); got != filepath.Join(home, "Library", "Application Support") {
		t.Fatalf("darwin configBaseDir() = %q", got)
	}
	if got := cacheBaseDir(); got != filepath.Join(home, "Library", "Caches") {
		t.Fatalf("darwin cacheBaseDir() = %q", got)
	}
	if got := stateBaseDir(); got != filepath.Join(home, "Library", "Application Support") {
		t.Fatalf("darwin stateBaseDir() = %q", got)
	}
}
