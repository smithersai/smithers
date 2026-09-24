package smitherscli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func commandsConfigCovSetConfigHome(t *testing.T) string {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	return configHome
}

func TestCommandsConfig_Cov_ValidateAndCommandLifecycle(t *testing.T) {
	commandsConfigCovSetConfigHome(t)

	for _, key := range []string{"api_origin", "api_url", "observe_url", "git_protocol"} {
		if err := validateConfigKey(key); err != nil {
			t.Fatalf("validateConfigKey(%q) returned error: %v", key, err)
		}
	}
	if err := validateConfigKey("agent_issue_repo"); err == nil {
		t.Fatal("agent_issue_repo is no longer a config key")
	}
	if err := validateConfigKey("token"); err == nil || !strings.Contains(err.Error(), "Unknown config key") {
		t.Fatalf("validateConfigKey unknown = %v", err)
	}

	var stdout bytes.Buffer
	if err := configCommand().ServeWithOptions([]string{"set", "api_origin", "https://api.example.com/api/", "--json"}, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("config set api_origin returned error: %v", err)
	}
	if !strings.Contains(stdout.String(), "api_origin") {
		t.Fatalf("config set output missing key:\n%s", stdout.String())
	}
	stdout.Reset()
	if err := configCommand().ServeWithOptions([]string{"set", "git_protocol", "https", "--json"}, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("config set git_protocol returned error: %v", err)
	}

	stdout.Reset()
	if err := configCommand().ServeWithOptions([]string{"get", "api_origin", "--json"}, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("config get returned error: %v", err)
	}
	if !strings.Contains(stdout.String(), "https://api.example.com") || strings.Contains(stdout.String(), "/api/") {
		t.Fatalf("config get did not show normalized URL:\n%s", stdout.String())
	}

	stdout.Reset()
	if err := configCommand().ServeWithOptions([]string{"list", "--json"}, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("config list returned error: %v", err)
	}
	for _, want := range []string{"api_origin", "git_protocol", "observe_url"} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("config list missing %q:\n%s", want, stdout.String())
		}
	}

	t.Setenv("SMITHERS_TOKEN", "commands_config_cov_token")
	stdout.Reset()
	if err := configCommand().ServeWithOptions([]string{"show"}, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("config show returned error: %v", err)
	}
	if !strings.Contains(stdout.String(), "SMITHERS_TOKEN:      (set)") || strings.Contains(stdout.String(), "agent_issue_repo") {
		t.Fatalf("config show missing effective env data:\n%s", stdout.String())
	}

	stdout.Reset()
	err := configCommand().ServeWithOptions([]string{"set", "git_protocol", "ftp"}, incur.ServeOptions{Stdout: &stdout})
	if err == nil || !strings.Contains(err.Error(), "Invalid value for git_protocol") {
		t.Fatalf("expected invalid git_protocol error, got %v", err)
	}
	err = configCommand().ServeWithOptions([]string{"get", "token"}, incur.ServeOptions{Stdout: &stdout})
	if err == nil || !strings.Contains(err.Error(), "Unknown config key") {
		t.Fatalf("expected unknown key error, got %v", err)
	}
}
