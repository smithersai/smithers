//go:build linux

package smitherscli

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func TestRootHelpAndVersion(t *testing.T) {
	cli := newCLIWithFeatureFlags(nil)
	for _, argv := range [][]string{{"--help"}, {"--version"}} {
		var stdout bytes.Buffer
		if err := cli.ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout}); err != nil {
			t.Fatalf("ServeWithOptions(%v) returned error: %v", argv, err)
		}
		if stdout.Len() == 0 {
			t.Fatalf("ServeWithOptions(%v) wrote no output", argv)
		}
	}
}

func TestRootHelpHidesInternalCommand(t *testing.T) {
	var stdout bytes.Buffer
	if err := newCLIWithFeatureFlags(nil).ServeWithOptions([]string{"--help"}, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("ServeWithOptions(--help) returned error: %v", err)
	}
	if strings.Contains(stdout.String(), "_internal") {
		t.Fatalf("root help exposed _internal command:\n%s", stdout.String())
	}
}

func TestRootHelpFeatureFlagFiltering(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_CLI_DISABLE_FEATURE_FLAG_HELP", "")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/feature-flags" {
			t.Fatalf("unexpected feature flag path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"flags":{"agents":false,"workflows":false}}`)
	}))
	defer server.Close()

	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+server.URL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	flags := loadFeatureFlagsForRootHelp([]string{"--help"})
	if flags["agents"] || flags["workflows"] {
		t.Fatalf("expected disabled feature flags, got %#v", flags)
	}

	var stdout bytes.Buffer
	if err := newCLIWithFeatureFlags(flags).ServeWithOptions([]string{"--help"}, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("ServeWithOptions(--help) returned error: %v", err)
	}
	help := stdout.String()
	for _, hidden := range []string{"agent", "artifact", "cache", "run", "workflow"} {
		if helpIncludesCommand(help, hidden) {
			t.Fatalf("root help included disabled command %q:\n%s", hidden, help)
		}
	}
	if !strings.Contains(help, "repo") {
		t.Fatalf("root help should still include enabled commands:\n%s", help)
	}
}

func helpIncludesCommand(help, command string) bool {
	for _, line := range strings.Split(help, "\n") {
		if strings.HasPrefix(line, "  "+command+" ") {
			return true
		}
	}
	return false
}

func TestCompletionMetadataIncludesCommandSurface(t *testing.T) {
	metadata := completionCommandMetadata()
	for _, command := range []string{
		"auth",
		"repo",
		"issue",
		"land",
		"change",
		"bookmark",
		"status",
		"search",
		"workflow",
		"run",
		"agent",
		"ssh-key",
		"secret",
		"variable",
		"label",
		"config",
		"api",
		"completion",
	} {
		if !strings.Contains(metadata, command) {
			t.Fatalf("completion metadata missing %q:\n%s", command, metadata)
		}
	}
	if !strings.Contains(metadata, "agent) session list view run chat") {
		t.Fatalf("completion metadata missing agent session migration surface:\n%s", metadata)
	}
}
