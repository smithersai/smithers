package smitherscli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func installFakeJjRecorder(t *testing.T, root string) (binDir string, logPath string) {
	t.Helper()
	binDir = filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	logPath = filepath.Join(root, "jj.log")
	script := `#!/bin/sh
{
  printf 'args=%s\n' "$*"
  printf 'count=%s\n' "$GIT_CONFIG_COUNT"
  printf 'key=%s\n' "$GIT_CONFIG_KEY_0"
  printf 'value=%s\n' "$GIT_CONFIG_VALUE_0"
} >> "$SMITHERS_TEST_JJ_LOG"
if [ "$1" = "--version" ]; then
  printf 'jj 0.33.0\n'
fi
`
	if err := os.WriteFile(filepath.Join(binDir, "jj"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return binDir, logPath
}

func TestPushLocalBookmarkUsesCommandScopedSmithersTokenHeader(t *testing.T) {
	root := t.TempDir()
	configHome := filepath.Join(root, "cfg")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: https://api.smithers.test\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	binDir, logPath := installFakeJjRecorder(t, root)
	t.Setenv("PATH", binDir)
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_TEST_JJ_LOG", logPath)
	t.Setenv("SMITHERS_TOKEN", "smithers_test_token")
	t.Setenv("GITHUB_TOKEN", "")

	if err := PushLocalBookmark("smithers/change123"); err != nil {
		t.Fatalf("PushLocalBookmark returned error: %v", err)
	}

	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	log := string(raw)
	if strings.Contains(log, "args=--ignore-working-copy git push --bookmark smithers/change123 smithers_test_token") {
		t.Fatalf("token leaked into argv log:\n%s", log)
	}
	if !strings.Contains(log, "args=--ignore-working-copy git push --bookmark smithers/change123") {
		t.Fatalf("push args not recorded:\n%s", log)
	}
	if !strings.Contains(log, "count=1") || !strings.Contains(log, "key=http.https://smithers.test/.extraHeader") {
		t.Fatalf("smithers token header must be scoped to the Smithers https origin, never unscoped http.extraHeader:\n%s", log)
	}
	if !strings.Contains(log, "value=Authorization: Bearer smithers_test_token") {
		t.Fatalf("smithers token header missing from command-scoped env:\n%s", log)
	}
}
