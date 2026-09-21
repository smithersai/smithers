//go:build linux

package smitherscli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTestJJConfig(t *testing.T, root, content string) string {
	t.Helper()
	path := filepath.Join(root, ".jj", "config.toml")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func readTestFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func disableRealJj(t *testing.T) {
	t.Helper()
	emptyBin := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(emptyBin, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", emptyBin)
}

func installFakeJjConfigPath(t *testing.T, configPath string) {
	t.Helper()
	fakeBin := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(fakeBin, 0o755); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
if [ "$1" = "config" ] && [ "$2" = "path" ] && [ "$3" = "--repo" ]; then
  printf '%s\n' "$SMITHERS_TEST_JJ_CONFIG_PATH"
  exit 0
fi
echo "unexpected jj args: $*" >&2
exit 1
`
	if err := os.WriteFile(filepath.Join(fakeBin, "jj"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", fakeBin)
	t.Setenv("SMITHERS_TEST_JJ_CONFIG_PATH", configPath)
}

func TestInstallPushHookCreatesHooksSectionWhenConfigMissing(t *testing.T) {
	root := t.TempDir()
	disableRealJj(t)

	if err := installPushHook(root); err != nil {
		t.Fatalf("installPushHook returned error: %v", err)
	}

	configPath := filepath.Join(root, ".jj", "config.toml")
	text := readTestFile(t, configPath)
	expected := "[hooks]\npost-operation = [\"" + jjPostOperationHook + "\"]"
	if !strings.Contains(text, expected) {
		t.Fatalf("config did not contain expected hook section:\n%s", text)
	}
}

func TestInstallPushHookAppendsWithoutDuplicates(t *testing.T) {
	root := t.TempDir()
	disableRealJj(t)
	configPath := writeTestJJConfig(t, root, strings.Join([]string{
		"[ui]",
		"default-command = \"log\"",
		"",
		"[hooks]",
		"post-operation = [\"other-hook\", \"smithers _internal push-to-smithers\"]",
		"",
	}, "\n"))

	if err := installPushHook(root); err != nil {
		t.Fatalf("installPushHook returned error: %v", err)
	}

	text := readTestFile(t, configPath)
	expected := "post-operation = [\"other-hook\", \"smithers _internal push-to-smithers\"]"
	if !strings.Contains(text, expected) {
		t.Fatalf("config did not preserve existing hooks without duplicates:\n%s", text)
	}
	if strings.Count(text, jjPostOperationHook) != 1 {
		t.Fatalf("expected exactly one smithers hook, got config:\n%s", text)
	}
}

func TestRemovePushHookRemovesOnlySmithersHook(t *testing.T) {
	root := t.TempDir()
	disableRealJj(t)
	configPath := writeTestJJConfig(t, root, strings.Join([]string{
		"[hooks]",
		"post-operation = [\"other-hook\", \"smithers _internal push-to-smithers\"]",
		"",
	}, "\n"))

	if err := removePushHook(root); err != nil {
		t.Fatalf("removePushHook returned error: %v", err)
	}

	text := readTestFile(t, configPath)
	if !strings.Contains(text, "post-operation = [\"other-hook\"]") {
		t.Fatalf("config did not preserve other hook:\n%s", text)
	}
	if strings.Contains(text, jjPostOperationHook) {
		t.Fatalf("config still contained smithers hook:\n%s", text)
	}
}

func TestRemovePushHookDeletesOnlyPostOperationAssignment(t *testing.T) {
	root := t.TempDir()
	disableRealJj(t)
	configPath := writeTestJJConfig(t, root, strings.Join([]string{
		"[hooks]",
		"post-operation = [\"smithers _internal push-to-smithers\"]",
		"pre-commit = [\"echo hi\"]",
		"",
	}, "\n"))

	if err := removePushHook(root); err != nil {
		t.Fatalf("removePushHook returned error: %v", err)
	}

	text := readTestFile(t, configPath)
	if strings.Contains(text, "post-operation") {
		t.Fatalf("post-operation assignment should have been removed:\n%s", text)
	}
	if !strings.Contains(text, "pre-commit = [\"echo hi\"]") {
		t.Fatalf("other hook assignment should have remained:\n%s", text)
	}
}

func TestInstallPushHookWritesActiveRepoConfigPath(t *testing.T) {
	root := t.TempDir()
	activePath := filepath.Join(root, ".jj", "repo", "config.toml")
	installFakeJjConfigPath(t, activePath)

	if err := installPushHook(root); err != nil {
		t.Fatalf("installPushHook returned error: %v", err)
	}

	localPath := filepath.Join(root, ".jj", "config.toml")
	for _, path := range []string{localPath, activePath} {
		text := readTestFile(t, path)
		if !strings.Contains(text, jjPostOperationHook) {
			t.Fatalf("%s did not contain smithers hook:\n%s", path, text)
		}
	}
}

func TestRemovePushHookRemovesActiveRepoConfigPath(t *testing.T) {
	root := t.TempDir()
	activePath := filepath.Join(root, ".jj", "repo", "config.toml")
	installFakeJjConfigPath(t, activePath)

	if err := installPushHook(root); err != nil {
		t.Fatalf("installPushHook returned error: %v", err)
	}
	if err := removePushHook(root); err != nil {
		t.Fatalf("removePushHook returned error: %v", err)
	}

	localPath := filepath.Join(root, ".jj", "config.toml")
	for _, path := range []string{localPath, activePath} {
		text := readTestFile(t, path)
		if strings.Contains(text, jjPostOperationHook) {
			t.Fatalf("%s still contained smithers hook:\n%s", path, text)
		}
	}
}
