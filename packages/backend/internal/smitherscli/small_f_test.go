package smitherscli

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func smallFSetConfig(t *testing.T, apiURL string) string {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	dir := filepath.Join(configHome, "smithers")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "config.toon")
	if err := os.WriteFile(path, []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestConfig_F_BaseDirsNonDarwin(t *testing.T) {
	old := cliGOOS
	cliGOOS = "linux"
	t.Cleanup(func() { cliGOOS = old })
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_CACHE_HOME", "")
	t.Setenv("XDG_STATE_HOME", "")
	home, _ := os.UserHomeDir()
	if got := configBaseDir(); got != filepath.Join(home, ".config") {
		t.Fatalf("configBaseDir linux = %q", got)
	}
	if got := cacheBaseDir(); got != filepath.Join(home, ".cache") {
		t.Fatalf("cacheBaseDir linux = %q", got)
	}
	if got := stateBaseDir(); got != filepath.Join(home, ".local", "state") {
		t.Fatalf("stateBaseDir linux = %q", got)
	}
}

func TestConfig_F_BaseDirsDarwin(t *testing.T) {
	old := cliGOOS
	cliGOOS = "darwin"
	t.Cleanup(func() { cliGOOS = old })
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_CACHE_HOME", "")
	t.Setenv("XDG_STATE_HOME", "")
	home, _ := os.UserHomeDir()
	if got := configBaseDir(); got != filepath.Join(home, "Library", "Application Support") {
		t.Fatalf("configBaseDir darwin = %q", got)
	}
	if got := cacheBaseDir(); got != filepath.Join(home, "Library", "Caches") {
		t.Fatalf("cacheBaseDir darwin = %q", got)
	}
	if got := stateBaseDir(); got != filepath.Join(home, "Library", "Application Support") {
		t.Fatalf("stateBaseDir darwin = %q", got)
	}
}

func TestConfig_F_SaveConfigMarshalAndMkdirErrors(t *testing.T) {
	smallFSetConfig(t, "https://api.example.com")

	oldMarshal := configMarshal
	configMarshal = func(any) ([]byte, error) { return nil, errors.New("marshal boom") }
	t.Cleanup(func() { configMarshal = oldMarshal })
	if err := SaveConfig(map[string]string{"api_url": "https://x"}); err == nil || !strings.Contains(err.Error(), "marshal boom") {
		t.Fatalf("SaveConfig marshal err = %v", err)
	}
	// ClearLegacyToken needs a token present to reach marshal.
	smallFSetConfigWithToken(t)
	if _, err := ClearLegacyToken(); err == nil || !strings.Contains(err.Error(), "marshal boom") {
		t.Fatalf("ClearLegacyToken marshal err = %v", err)
	}
	configMarshal = oldMarshal

	oldMkdir := configMkdirAll
	configMkdirAll = func(string, os.FileMode) error { return errors.New("mkdir boom") }
	t.Cleanup(func() { configMkdirAll = oldMkdir })
	if err := SaveConfig(map[string]string{"api_url": "https://x"}); err == nil || !strings.Contains(err.Error(), "mkdir boom") {
		t.Fatalf("SaveConfig mkdir err = %v", err)
	}
	smallFSetConfigWithToken(t)
	if _, err := ClearLegacyToken(); err == nil || !strings.Contains(err.Error(), "mkdir boom") {
		t.Fatalf("ClearLegacyToken mkdir err = %v", err)
	}
}

func smallFSetConfigWithToken(t *testing.T) {
	t.Helper()
	path := ConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("api_url: https://api.example.com\ntoken: legacy-token\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestConfig_F_ClearLegacyTokenNoToken(t *testing.T) {
	smallFSetConfig(t, "https://api.example.com")
	cleared, err := ClearLegacyToken()
	if err != nil || cleared {
		t.Fatalf("ClearLegacyToken no token = %v, %v", cleared, err)
	}
}

func smallFServeConfig(t *testing.T, argv ...string) error {
	t.Helper()
	var out strings.Builder
	return configCommand().ServeWithOptions(argv, incur.ServeOptions{Stdout: &out})
}

func TestCommandsConfig_F_GetSetShow(t *testing.T) {
	smallFSetConfig(t, "https://api.example.com")
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_TOKEN", "")

	if err := smallFServeConfig(t, "get", "git_protocol"); err != nil {
		t.Fatalf("get git_protocol err = %v", err)
	}
	if err := smallFServeConfig(t, "get", "agent_issue_repo"); err == nil {
		t.Fatal("get agent_issue_repo should error: the key was removed")
	}
	if err := smallFServeConfig(t, "get", "api_url"); err != nil {
		t.Fatalf("get api_url err = %v", err)
	}
	if err := smallFServeConfig(t, "get", "token"); err == nil {
		t.Fatal("get token should error")
	}

	if err := smallFServeConfig(t, "set", "boguskey", "val"); err == nil {
		t.Fatal("set invalid key should error")
	}
	if err := smallFServeConfig(t, "set", "git_protocol", "ftp"); err == nil {
		t.Fatal("set invalid git_protocol should error")
	}
	if err := smallFServeConfig(t, "set", "api_url", "https://new"); err != nil {
		t.Fatalf("set api_url err = %v", err)
	}

	// force SaveConfig error via the mkdir seam.
	oldMkdir := configMkdirAll
	configMkdirAll = func(string, os.FileMode) error { return errors.New("save boom") }
	if err := smallFServeConfig(t, "set", "api_url", "https://new"); err == nil {
		t.Fatal("set SaveConfig failure should error")
	}
	configMkdirAll = oldMkdir

	if err := smallFServeConfig(t, "show"); err != nil {
		t.Fatalf("show human err = %v", err)
	}
	if err := smallFServeConfig(t, "show", "--json"); err != nil {
		t.Fatalf("show explicit err = %v", err)
	}
	// show with env overrides set to exercise the (set) / value branches.
	t.Setenv("SMITHERS_TOKEN", "tok")
	if err := smallFServeConfig(t, "show"); err != nil {
		t.Fatalf("show with env err = %v", err)
	}
}

func TestOutputFormat_F_AppendToonMissingKeys(t *testing.T) {
	var lines []string
	record := map[string]any{"other": "x"}
	appendNestedToonField(&lines, record, "missing", false)
	appendDoubleNestedToonField(&lines, record, "missing", false)
	appendListToonField(&lines, record, "missing", false, true)
	if len(lines) != 0 {
		t.Fatalf("expected no lines for missing keys, got %#v", lines)
	}
	// present keys append
	present := map[string]any{"k": "v"}
	appendNestedToonField(&lines, present, "k", true)
	appendDoubleNestedToonField(&lines, present, "k", true)
	appendListToonField(&lines, present, "k", true, false)
	appendListToonField(&lines, present, "k", true, true)
	if len(lines) != 4 {
		t.Fatalf("expected 4 appended lines, got %#v", lines)
	}
}

func TestArgs_F_PositionalAndRewrites(t *testing.T) {
	if isLikelyPositionalArgumentToken("") {
		t.Fatal("empty token should not be positional")
	}
	// --json as last token (i+1 >= len)
	if got := rewriteJSONFieldSelection([]string{"issue", "list", "--json"}); got[len(got)-1] != "--json" {
		t.Fatalf("trailing --json rewrite = %#v", got)
	}
	// repo clone with a bare flag, a flag-that-takes-value, and 3 positionals
	out := rewriteRepoCloneArgv([]string{"repo", "clone", "--bare", "--directory", "dst", "owner/repo", "second", "third"})
	joined := strings.Join(out, " ")
	if !strings.Contains(joined, "--directory dst") {
		t.Fatalf("clone rewrite missing directory flag: %#v", out)
	}
	if !strings.Contains(joined, "--bare") {
		t.Fatalf("clone rewrite dropped bare flag: %#v", out)
	}
	if !strings.Contains(joined, "third") {
		t.Fatalf("clone rewrite missing extra positional: %#v", out)
	}
}

func TestCompletion_F_UnknownShell(t *testing.T) {
	if _, err := completionHandler(&incur.CommandContext{Args: map[string]any{"shell": "powershell"}}); err == nil || !strings.Contains(err.Error(), "Unknown shell") {
		t.Fatalf("unknown shell err = %v", err)
	}
	if _, err := completionHandler(&incur.CommandContext{Args: map[string]any{"shell": "bash"}}); err != nil {
		t.Fatalf("bash shell err = %v", err)
	}
}

func TestRun_F_RunNormalPathAndServeExit(t *testing.T) {
	t.Setenv("SMITHERS_CLI_DISABLE_FEATURE_FLAG_HELP", "1")
	if code := Run([]string{"--version"}); code != 0 {
		t.Fatalf("Run --version exit = %d", code)
	}
	// serveCLI: a non-IncurError (builtin flag parse error) falls through to return 1.
	anyCLI := incur.New("z", incur.WithRootCommand(&incur.CommandDef{
		Handler: func(ctx *incur.CommandContext) (any, error) { return "ok", nil },
	}))
	if code := serveCLI(anyCLI, []string{"--token-limit=abc"}); code != 1 {
		t.Fatalf("serveCLI parse error = %d", code)
	}
}

func TestRun_F_NewCLIVersionFallback(t *testing.T) {
	t.Setenv("SMITHERS_CLI_VERSION", "")
	cli := newCLIWithFeatureFlags(nil)
	if cli == nil {
		t.Fatal("expected cli")
	}
}

func TestRun_F_LoadFeatureFlagsErrorPaths(t *testing.T) {
	t.Setenv("SMITHERS_CLI_DISABLE_FEATURE_FLAG_HELP", "")

	// NewRequestWithContext error: a space in the host is a valid YAML scalar
	// but an invalid URL, so http.NewRequestWithContext fails.
	smallFSetConfig(t, "http://bad host.invalid")
	if flags := loadFeatureFlagsForRootHelp([]string{"--help"}); flags != nil {
		t.Fatalf("bad request URL flags = %#v", flags)
	}

	// Do error: connection refused.
	smallFSetConfig(t, "http://127.0.0.1:1")
	if flags := loadFeatureFlagsForRootHelp([]string{"--help"}); flags != nil {
		t.Fatalf("unreachable server flags = %#v", flags)
	}

	// Non-2xx status.
	errServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer errServer.Close()
	smallFSetConfig(t, errServer.URL)
	if flags := loadFeatureFlagsForRootHelp([]string{"--help"}); flags != nil {
		t.Fatalf("500 status flags = %#v", flags)
	}
}
