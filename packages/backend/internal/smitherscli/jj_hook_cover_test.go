package smitherscli

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func jjHookCovReadFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func jjHookCovInstallFakeConfigPathJj(t *testing.T, repoConfigPath string) string {
	t.Helper()
	binDir := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
if [ "$1" = "config" ] && [ "$2" = "path" ] && [ "$3" = "--repo" ]; then
  printf '%s\n' "$SMITHERS_JJ_HOOK_COV_REPO_CONFIG"
  exit 0
fi
printf 'unexpected jj args: %s\n' "$*" >&2
exit 1
`
	if err := os.WriteFile(filepath.Join(binDir, "jj"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("SMITHERS_JJ_HOOK_COV_REPO_CONFIG", repoConfigPath)
	return binDir
}

func TestJjHook_Cov_ParsersAndRendering(t *testing.T) {
	if got := splitConfigLines("a\r\nb\n"); !reflect.DeepEqual(got, []string{"a", "b", ""}) {
		t.Fatalf("splitConfigLines = %#v", got)
	}
	for _, tc := range []struct {
		line string
		want string
	}{
		{`key = "value # not comment" # comment`, `key = "value # not comment" `},
		{`key = 'value # not comment' # comment`, `key = 'value # not comment' `},
		{`key = "escaped \" # still quoted" # comment`, `key = "escaped \" # still quoted" `},
		{`key = value # comment`, `key = value `},
	} {
		if got := stripInlineComment(tc.line); got != tc.want {
			t.Fatalf("stripInlineComment(%q) = %q, want %q", tc.line, got, tc.want)
		}
	}

	values := parseTomlStringArray(`["one", "two \"quoted\"", 'three', invalid]`)
	if !reflect.DeepEqual(values, []string{"one", `two "quoted"`, "three"}) {
		t.Fatalf("parseTomlStringArray = %#v", values)
	}
	if got := renderTomlStringArray([]string{`one`, `two "quoted"`, `one`, `back\slash`}); got != `["one", "two \"quoted\"", "back\\slash"]` {
		t.Fatalf("renderTomlStringArray = %s", got)
	}

	lines := []string{
		"[ui]",
		"default-command = \"log\"",
		"",
		"[hooks]",
		"broken post-operation line",
		"post-operation = [",
		`  "first", # inline`,
		`  'second'`,
		"]",
		"[revsets]",
	}
	section := findHooksSection(lines)
	if section == nil || section.start != 3 || section.end != 9 {
		t.Fatalf("findHooksSection = %#v", section)
	}
	assignment := findPostOperationAssignment(lines, section)
	if assignment == nil || assignment.start != 5 || assignment.end != 9 || !reflect.DeepEqual(assignment.values, []string{"first", "second"}) {
		t.Fatalf("findPostOperationAssignment = %#v", assignment)
	}
	if got := findHooksSection([]string{"[ui]"}); got != nil {
		t.Fatalf("findHooksSection without hooks = %#v", got)
	}
	if got := findPostOperationAssignment([]string{"[hooks]", "post-operation []"}, &sectionRange{start: 0, end: 2}); got != nil {
		t.Fatalf("findPostOperationAssignment without equals = %#v", got)
	}
	if bracketDepth("[[x]] [") != 1 || bracketDepth("]") != -1 {
		t.Fatal("bracketDepth returned unexpected values")
	}
}

func TestJjHook_Cov_ConfigPathsAndMutations(t *testing.T) {
	root := t.TempDir()
	repoConfig := filepath.Join(root, ".jj", "repo", "config.toml")
	jjHookCovInstallFakeConfigPathJj(t, repoConfig)

	if got := resolveRepoConfigPath(root); got != repoConfig {
		t.Fatalf("resolveRepoConfigPath absolute = %q, want %q", got, repoConfig)
	}
	paths := targetJJConfigPaths(root)
	wantPaths := []string{filepath.Join(root, ".jj", "config.toml"), repoConfig}
	if !reflect.DeepEqual(paths, wantPaths) {
		t.Fatalf("targetJJConfigPaths = %#v, want %#v", paths, wantPaths)
	}

	relativeRoot := t.TempDir()
	jjHookCovInstallFakeConfigPathJj(t, filepath.Join("repo", "config.toml"))
	if got := resolveRepoConfigPath(relativeRoot); got != filepath.Join(relativeRoot, "repo", "config.toml") {
		t.Fatalf("resolveRepoConfigPath relative = %q", got)
	}
	jjHookCovInstallFakeConfigPathJj(t, filepath.Join(relativeRoot, ".jj", "config.toml"))
	if got := targetJJConfigPaths(relativeRoot); !reflect.DeepEqual(got, []string{filepath.Join(relativeRoot, ".jj", "config.toml")}) {
		t.Fatalf("targetJJConfigPaths did not dedupe = %#v", got)
	}

	missing := filepath.Join(root, "missing.toml")
	if got := readJJConfig(missing); got != "" {
		t.Fatalf("readJJConfig missing = %q", got)
	}
	writePath := filepath.Join(root, "nested", "config.toml")
	if err := writeJJConfig(writePath, "[ui]"); err != nil {
		t.Fatalf("writeJJConfig returned error: %v", err)
	}
	if got := jjHookCovReadFile(t, writePath); got != "[ui]\n" {
		t.Fatalf("writeJJConfig text = %q", got)
	}
	blocker := filepath.Join(root, "blocker")
	if err := os.WriteFile(blocker, []byte("file"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeJJConfig(filepath.Join(blocker, "config.toml"), "x"); err == nil {
		t.Fatal("writeJJConfig succeeded below a regular file")
	}

	noHooks := filepath.Join(root, "no-hooks.toml")
	if err := os.WriteFile(noHooks, []byte("[ui]\ndefault-command = \"log\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := installPushHookAtPath(noHooks); err != nil {
		t.Fatalf("installPushHookAtPath no hooks returned error: %v", err)
	}
	if text := jjHookCovReadFile(t, noHooks); !strings.Contains(text, "[hooks]\npost-operation = [\""+jjPostOperationHook+"\"]") {
		t.Fatalf("missing hooks install text:\n%s", text)
	}

	existingHooks := filepath.Join(root, "existing-hooks.toml")
	if err := os.WriteFile(existingHooks, []byte("[hooks]\npre-commit = [\"echo hi\"]\n[ui]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := installPushHookAtPath(existingHooks); err != nil {
		t.Fatalf("installPushHookAtPath existing hooks returned error: %v", err)
	}
	if text := jjHookCovReadFile(t, existingHooks); !strings.Contains(text, "post-operation = [\""+jjPostOperationHook+"\"]\n[ui]") {
		t.Fatalf("existing hooks install text:\n%s", text)
	}

	withAssignment := filepath.Join(root, "assignment.toml")
	if err := os.WriteFile(withAssignment, []byte("[hooks]\npost-operation = [\"first\"]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := installPushHookAtPath(withAssignment); err != nil {
		t.Fatalf("installPushHookAtPath assignment returned error: %v", err)
	}
	text := jjHookCovReadFile(t, withAssignment)
	if !strings.Contains(text, "post-operation = [\"first\", \""+jjPostOperationHook+"\"]") {
		t.Fatalf("assignment install text:\n%s", text)
	}
	if err := installPushHookAtPath(withAssignment); err != nil {
		t.Fatalf("idempotent install returned error: %v", err)
	}
	if text = jjHookCovReadFile(t, withAssignment); strings.Count(text, jjPostOperationHook) != 1 {
		t.Fatalf("idempotent install duplicated hook:\n%s", text)
	}

	removeOnly := filepath.Join(root, "remove-only.toml")
	if err := os.WriteFile(removeOnly, []byte("[hooks]\npost-operation = [\""+jjPostOperationHook+"\"]\npre-commit = [\"echo hi\"]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := removePushHookAtPath(removeOnly); err != nil {
		t.Fatalf("removePushHookAtPath only returned error: %v", err)
	}
	if text := jjHookCovReadFile(t, removeOnly); strings.Contains(text, "post-operation") || !strings.Contains(text, "pre-commit") {
		t.Fatalf("remove-only text:\n%s", text)
	}
	removeMixed := filepath.Join(root, "remove-mixed.toml")
	if err := os.WriteFile(removeMixed, []byte("[hooks]\npost-operation = [\"first\", \""+jjPostOperationHook+"\"]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := removePushHookAtPath(removeMixed); err != nil {
		t.Fatalf("removePushHookAtPath mixed returned error: %v", err)
	}
	if text := jjHookCovReadFile(t, removeMixed); !strings.Contains(text, "post-operation = [\"first\"]") || strings.Contains(text, jjPostOperationHook) {
		t.Fatalf("remove-mixed text:\n%s", text)
	}
	if err := removePushHookAtPath(filepath.Join(root, "does-not-exist.toml")); err != nil {
		t.Fatalf("removePushHookAtPath missing returned error: %v", err)
	}
	noAssignment := filepath.Join(root, "no-assignment.toml")
	if err := os.WriteFile(noAssignment, []byte("[hooks]\npre-commit = [\"echo hi\"]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := removePushHookAtPath(noAssignment); err != nil {
		t.Fatalf("removePushHookAtPath no assignment returned error: %v", err)
	}

	fullRoot := filepath.Join(root, "repo-root")
	if err := os.MkdirAll(fullRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	activeConfig := filepath.Join(fullRoot, ".jj", "active", "config.toml")
	jjHookCovInstallFakeConfigPathJj(t, activeConfig)
	if err := installPushHook(fullRoot); err != nil {
		t.Fatalf("installPushHook returned error: %v", err)
	}
	for _, path := range []string{filepath.Join(fullRoot, ".jj", "config.toml"), activeConfig} {
		if text := jjHookCovReadFile(t, path); !strings.Contains(text, jjPostOperationHook) {
			t.Fatalf("%s missing installed hook:\n%s", path, text)
		}
	}
	if err := removePushHook(fullRoot); err != nil {
		t.Fatalf("removePushHook returned error: %v", err)
	}
	for _, path := range []string{filepath.Join(fullRoot, ".jj", "config.toml"), activeConfig} {
		if text := jjHookCovReadFile(t, path); strings.Contains(text, jjPostOperationHook) {
			t.Fatalf("%s still has hook:\n%s", path, text)
		}
	}
}
