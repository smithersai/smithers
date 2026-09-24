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

func runCovSetConfig(t *testing.T, apiURL string) {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRun_Cov_RunAndServeCLIExitCodes(t *testing.T) {
	if code := Run([]string{"_internal", "--help"}); code != 0 {
		t.Fatalf("Run(_internal --help) exit = %d", code)
	}

	okCLI := incur.New("ok", incur.WithRootCommand(&incur.CommandDef{
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return "ok", nil
		},
	}))
	if code := serveCLI(okCLI, nil); code != 0 {
		t.Fatalf("serveCLI success exit = %d", code)
	}

	errCLI := incur.New("err", incur.WithRootCommand(&incur.CommandDef{
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return nil, errors.New("plain failure")
		},
	}))
	if code := serveCLI(errCLI, nil); code != 1 {
		t.Fatalf("serveCLI plain error exit = %d", code)
	}

	incurErrCLI := incur.New("err", incur.WithRootCommand(&incur.CommandDef{
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return nil, incur.NewIncurError(incur.IncurErrorOptions{Code: "COV", Message: "custom failure", ExitCode: 7})
		},
	}))
	if code := serveCLI(incurErrCLI, nil); code != 7 {
		t.Fatalf("serveCLI incur error exit = %d", code)
	}
}

func TestRun_Cov_NewCLIAndFeatureFlagFiltering(t *testing.T) {
	cli := newCLIWithFeatureFlags(nil)
	if err := cli.ServeWithOptions([]string{"--version"}, incur.ServeOptions{}); err != nil {
		t.Fatalf("NewCLI version returned error: %v", err)
	}

	filtered := newCLIWithFeatureFlags(featureFlags{"agents": false, "workflows": false, "stacked_prs": false})
	var stdout strings.Builder
	if err := filtered.ServeWithOptions([]string{"--help"}, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("filtered help returned error: %v", err)
	}
	help := stdout.String()
	for _, hidden := range []string{"agent", "artifact", "cache", "run", "workflow", "land", "stack"} {
		if strings.Contains(help, "\n  "+hidden+" ") {
			t.Fatalf("filtered help included disabled command %q:\n%s", hidden, help)
		}
	}
	if !strings.Contains(help, "repo") {
		t.Fatalf("filtered help should keep unflagged commands:\n%s", help)
	}
}

func TestRun_Cov_ShouldLoadFeatureFlagsForRootHelp(t *testing.T) {
	t.Setenv("SMITHERS_CLI_DISABLE_FEATURE_FLAG_HELP", "")
	cases := []struct {
		name string
		argv []string
		want bool
	}{
		{name: "root long help", argv: []string{"--help"}, want: true},
		{name: "root short help", argv: []string{"-h"}, want: true},
		{name: "no help", argv: []string{"--version"}, want: false},
		{name: "command help", argv: []string{"repo", "--help"}, want: false},
	}
	for _, tc := range cases {
		if got := shouldLoadFeatureFlagsForRootHelp(tc.argv); got != tc.want {
			t.Fatalf("%s: shouldLoadFeatureFlagsForRootHelp(%v) = %t, want %t", tc.name, tc.argv, got, tc.want)
		}
	}
	t.Setenv("SMITHERS_CLI_DISABLE_FEATURE_FLAG_HELP", "1")
	if shouldLoadFeatureFlagsForRootHelp([]string{"--help"}) {
		t.Fatal("feature flag help loading should be disabled by env")
	}
}

func TestRun_Cov_LoadFeatureFlagsForRootHelp(t *testing.T) {
	t.Setenv("SMITHERS_CLI_DISABLE_FEATURE_FLAG_HELP", "")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/feature-flags" {
			t.Fatalf("unexpected feature flag path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"flags":{"agents":false,"workflows":true,"ignored":"yes"}}`)
	}))
	defer server.Close()
	runCovSetConfig(t, server.URL)
	flags := loadFeatureFlagsForRootHelp([]string{"--help"})
	if flags["agents"] != false || flags["workflows"] != true {
		t.Fatalf("feature flags = %#v", flags)
	}
	if _, ok := flags["ignored"]; ok {
		t.Fatalf("non-boolean feature flag should be ignored: %#v", flags)
	}

	if flags := loadFeatureFlagsForRootHelp([]string{"repo", "--help"}); flags != nil {
		t.Fatalf("command help should not load feature flags: %#v", flags)
	}

	badJSON := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `not-json`)
	}))
	defer badJSON.Close()
	runCovSetConfig(t, badJSON.URL)
	if flags := loadFeatureFlagsForRootHelp([]string{"--help"}); flags != nil {
		t.Fatalf("bad JSON should return nil flags: %#v", flags)
	}
}
