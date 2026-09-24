package smitherscli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func commandsLocalCovStringPtr(value string) *string {
	return &value
}

func commandsLocalCovInstallFakeJj(t *testing.T) string {
	t.Helper()
	binDir := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'jj 0.33.0\n'
  exit 0
fi
if [ "$1" = "log" ] && [ "$2" = "-r" ]; then
  case "$3" in
    "@") printf 'wc123\tcommit-wc\tWorking change\n' ;;
    "@-") printf 'parent1\tcommit-parent\tParent change\n' ;;
    "chg1") printf 'raw change details\n' ;;
    *) printf '%s\tcommit-%s\tDescription %s\n' "$3" "$3" "$3" ;;
  esac
  exit 0
fi
if [ "$1" = "diff" ] && [ "$2" = "--summary" ]; then
  printf 'M file.go\nC conflict.txt\n'
  exit 0
fi
if [ "$1" = "diff" ] && [ "$2" = "-r" ]; then
  printf 'diff for %s\n' "$3"
  exit 0
fi
if [ "$1" = "bookmark" ] && [ "$2" = "list" ]; then
  if [ "$5" = "feature" ]; then
    printf 'feature\tchg1\tcommit1\n'
  else
    printf 'main\tbase\tcommit-base\nfeature\tchg1\tcommit1\n'
  fi
  exit 0
fi
if [ "$1" = "bookmark" ] && [ "$2" = "create" ]; then
  exit 0
fi
if [ "$1" = "bookmark" ] && [ "$2" = "delete" ]; then
  exit 0
fi
if [ "$1" = "log" ] && [ "$2" = "-n" ]; then
  printf 'chg1\tFirst change\nchg2\t\n'
  exit 0
fi
printf 'unexpected jj args: %s\n' "$*" >&2
exit 1
`
	if err := os.WriteFile(filepath.Join(binDir, "jj"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	return binDir
}

func TestCommandsLocal_Cov_CommandConstructorsAndHandlers(t *testing.T) {
	commandsLocalCovInstallFakeJj(t)
	for _, tc := range []struct {
		name string
		cli  *incur.Cli
		args []string
		want string
	}{
		{name: "status", cli: statusCommand(), args: nil, want: "Working copy: wc123 Working change"},
		{name: "bookmark list", cli: bookmarkCommand(), args: []string{"list"}, want: "main base"},
		{name: "bookmark create", cli: bookmarkCommand(), args: []string{"create", "feature", "--change", "chg1"}, want: "Created bookmark feature"},
		{name: "bookmark delete", cli: bookmarkCommand(), args: []string{"delete", "feature"}, want: "Deleted bookmark feature"},
		{name: "change list", cli: changeCommand(), args: []string{"list", "--limit", "2"}, want: "chg1 First change"},
		{name: "change show", cli: changeCommand(), args: []string{"show", "chg1"}, want: "raw change details"},
		{name: "change diff", cli: changeCommand(), args: []string{"diff", "chg1"}, want: "diff for chg1"},
		{name: "change files", cli: changeCommand(), args: []string{"files", "chg1", "--json"}, want: "file.go"},
		{name: "change conflicts", cli: changeCommand(), args: []string{"conflicts", "chg1", "--json"}, want: "conflict.txt"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var stdout bytes.Buffer
			if err := tc.cli.ServeWithOptions(tc.args, incur.ServeOptions{Stdout: &stdout}); err != nil {
				t.Fatalf("ServeWithOptions(%v) returned error: %v", tc.args, err)
			}
			if !strings.Contains(stdout.String(), tc.want) {
				t.Fatalf("output missing %q:\n%s", tc.want, stdout.String())
			}
		})
	}
}

func TestCommandsLocal_Cov_FormatStatusBranches(t *testing.T) {
	status := LocalStatusSummary{
		WorkingCopy: LocalRevisionSummary{ChangeID: "wc", CommitID: "cw", Description: "Work"},
		Parent:      LocalRevisionSummary{ChangeID: "parent", CommitID: "cp", Description: "Base"},
		Files:       []StatusFileSummary{{Status: "M", Path: "main.go"}, {Status: "A", Path: "new file.txt"}},
	}
	plain := formatStatus(status)
	if !strings.Contains(plain, "Working copy: wc Work") || !strings.Contains(plain, "M main.go") {
		t.Fatalf("formatStatus = %q", plain)
	}
	toon := formatStatusToon(status)
	if !strings.Contains(toon, "files[2]{path,status}:") || !strings.Contains(toon, "new file.txt,A") {
		t.Fatalf("formatStatusToon with files = %q", toon)
	}
	status.Files = nil
	if toon = formatStatusToon(status); !strings.Contains(toon, "files[0]:") {
		t.Fatalf("formatStatusToon empty files = %q", toon)
	}
}

func TestCommandsLocal_Cov_ToonFormattersAndScalars(t *testing.T) {
	changes := []LocalChangeSummary{{ChangeID: "c1", Description: "Title"}, {ChangeID: "c2"}}
	changeOut := formatChangeListToon(changes)
	if !strings.Contains(changeOut, "[2]{change_id,description}:") || !strings.Contains(changeOut, `c2,""`) {
		t.Fatalf("formatChangeListToon = %q", changeOut)
	}

	bookmarks := []LocalBookmark{{
		Name: "main", TargetChangeID: commandsLocalCovStringPtr("chg"), TargetCommitID: commandsLocalCovStringPtr("commit"),
	}, {Name: "empty"}}
	listOut := formatBookmarkListToon(bookmarks)
	if !strings.Contains(listOut, "main,chg,commit") || !strings.Contains(listOut, "empty,null,null") {
		t.Fatalf("formatBookmarkListToon = %q", listOut)
	}
	bookmarkOut := formatBookmarkToon(bookmarks[0])
	if !strings.Contains(bookmarkOut, "name: main") || !strings.Contains(bookmarkOut, "target_commit_id: commit") {
		t.Fatalf("formatBookmarkToon = %q", bookmarkOut)
	}
	if toonEmptyQuoted("") != `""` || toonEmptyQuoted("value") != "value" {
		t.Fatal("toonEmptyQuoted returned unexpected value")
	}
	if toonStringPtr(nil) != "null" || toonStringPtr(commandsLocalCovStringPtr("value")) != "value" {
		t.Fatal("toonStringPtr returned unexpected value")
	}
}

func TestCommandsLocal_Cov_OptionalSuffixAndIntValue(t *testing.T) {
	if optionalSuffix("") != "" || optionalSuffix("details") != " details" {
		t.Fatal("optionalSuffix returned unexpected value")
	}
	for _, tc := range []struct {
		value any
		want  int
	}{
		{int(2), 2},
		{int64(3), 3},
		{float64(4.9), 4},
		{float32(5.2), 5},
		{"bad", 9},
	} {
		if got := intValue(tc.value, 9); got != tc.want {
			t.Fatalf("intValue(%#v) = %d, want %d", tc.value, got, tc.want)
		}
	}
}
