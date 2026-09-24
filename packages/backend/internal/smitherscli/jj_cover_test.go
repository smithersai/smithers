package smitherscli

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func jjCovInstallFakeJj(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(root, "jj.log")
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$SMITHERS_JJ_COV_LOG"
if [ "$1" = "--version" ]; then
  printf 'jj 0.99.0\n'
  exit 0
fi
if [ "$1" = "envcheck" ]; then
  printf '%s\n' "$JJ_COV_VALUE"
  exit 0
fi
if [ "$1" = "fail" ]; then
  printf 'stderr failure\n' >&2
  exit 7
fi
if [ "$1" = "--ignore-working-copy" ]; then
  shift
fi
args="$*"
if [ "$1" = "bookmark" ] && [ "$2" = "list" ]; then
  if [ "$3" != "-T" ]; then
    printf 'bookmark list must pass a template\n' >&2
    exit 9
  fi
  if [ "$5" = "missing" ]; then
    exit 0
  fi
  if [ "$5" = "feature" ]; then
    printf 'feature\tchg1\tcommit1\n'
    exit 0
  fi
  printf 'main\tbase\tcommit-base\nfeature\tchg1\tcommit1\n\n'
  exit 0
fi
if [ "$1" = "bookmark" ] && [ "$2" = "create" ]; then
  exit 0
fi
if [ "$1" = "bookmark" ] && [ "$2" = "delete" ]; then
  exit 0
fi
if [ "$1" = "bookmark" ] && [ "$2" = "set" ]; then
  exit 0
fi
if [ "$1" = "git" ] && [ "$2" = "push" ]; then
  exit 0
fi
if [ "$1" = "git" ] && [ "$2" = "fetch" ]; then
  exit 0
fi
if [ "$1" = "log" ] && [ "$2" = "-n" ]; then
  printf 'chg1\tFirst change\nchg2\tdesc\twith tab\n'
  exit 0
fi
if [ "$1" = "log" ] && [ "$2" = "-r" ]; then
  case "$args" in
    *'author.name()'*)
      printf 'Ada "Dev"\tada@example.com\n'
      exit 0
      ;;
    *'description ++ "\n"'*)
      case "$3" in
        chg1) printf 'Full description for chg1\n' ;;
        chg2) printf 'Full description for chg2\n' ;;
        *) printf '\n' ;;
      esac
      exit 0
      ;;
    *'change_id ++ "\t" ++ commit_id ++ "\n"'*)
      printf 'chg1\tcommit1\nbad-line\nchg2\tcommit2\n'
      exit 0
      ;;
    *'change_id ++ "\n"'*)
      printf 'chg1\n\nchg2\n'
      exit 0
      ;;
    *)
      case "$3" in
        @) printf 'wc123\tcommit-wc\tWorking change\n' ;;
        @-) printf 'parent1\tcommit-parent\tParent change\n' ;;
        empty) exit 0 ;;
        chg1) printf 'chg1\tcommit-chg1\tFeature change\n' ;;
        *) printf '%s\tcommit-%s\tRevision %s\n' "$3" "$3" "$3" ;;
      esac
      exit 0
      ;;
  esac
fi
if [ "$1" = "diff" ] && [ "$2" = "--summary" ]; then
  printf 'M file.go\nC conflict.txt\nnot-a-summary\n'
  exit 0
fi
if [ "$1" = "diff" ] && [ "$2" = "-r" ]; then
  printf 'diff for %s\n' "$3"
  exit 0
fi
case "$args" in
  *'rebase --revisions chg1 --onto main'*)
    exit 0
    ;;
esac
printf 'unexpected jj args: %s\n' "$args" >&2
exit 1
`
	if err := os.WriteFile(filepath.Join(binDir, "jj"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("SMITHERS_JJ_COV_LOG", logPath)
	return logPath
}

func jjCovStringPtrValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func TestJj_Cov_CommandWorkflowsAndParsers(t *testing.T) {
	logPath := jjCovInstallFakeJj(t)

	out, err := runJjWithEnv([]string{"envcheck"}, []string{"JJ_COV_VALUE=from-env"})
	if err != nil || out != "from-env" {
		t.Fatalf("runJjWithEnv envcheck = (%q, %v)", out, err)
	}
	if _, err := runJj([]string{"fail"}); err == nil || !strings.Contains(err.Error(), "stderr failure") {
		t.Fatalf("runJj did not return stderr detail, err=%v", err)
	}

	if got := escapeJjStringLiteral(`a\b"c`); got != `a\\b\"c` {
		t.Fatalf("escapeJjStringLiteral = %q", got)
	}
	if got := escapeTomlString(`Ada "Dev"\team`); got != `Ada \"Dev\"\\team` {
		t.Fatalf("escapeTomlString = %q", got)
	}
	originalArgs := []string{"log"}
	if got := applyLocalReadOptions(originalArgs, LocalReadOptions{}); !reflect.DeepEqual(got, originalArgs) {
		t.Fatalf("applyLocalReadOptions without option = %#v", got)
	}
	if got := applyLocalReadOptions(originalArgs, LocalReadOptions{IgnoreWorkingCopy: true}); !reflect.DeepEqual(got, []string{"--ignore-working-copy", "log"}) {
		t.Fatalf("applyLocalReadOptions with option = %#v", got)
	}

	bookmark, ok := parseBookmarkLine("topic\tchg\tcommit")
	if !ok || bookmark.Name != "topic" || jjCovStringPtrValue(bookmark.TargetChangeID) != "chg" || jjCovStringPtrValue(bookmark.TargetCommitID) != "commit" {
		t.Fatalf("parseBookmarkLine with target = %#v", bookmark)
	}
	if conflicted, ok := parseBookmarkLine("loose\t\t"); !ok || conflicted.Name != "loose" || conflicted.TargetChangeID != nil || conflicted.TargetCommitID != nil {
		t.Fatalf("parseBookmarkLine conflicted = %#v", conflicted)
	}
	for _, junk := range []string{"", "  @origin (behind by 2 commits): lwsrlprt 45d6485f first", "main: nypooxll f2da0f1f second"} {
		if _, ok := parseBookmarkLine(junk); ok {
			t.Fatalf("parseBookmarkLine accepted human-readable line %q", junk)
		}
	}
	bookmarks, err := ListLocalBookmarks(nil, LocalReadOptions{IgnoreWorkingCopy: true})
	if err != nil || len(bookmarks) != 2 || bookmarks[1].Name != "feature" {
		t.Fatalf("ListLocalBookmarks = (%#v, %v)", bookmarks, err)
	}
	emptyBookmarks, err := ListLocalBookmarks([]string{"missing"}, LocalReadOptions{})
	if err != nil || len(emptyBookmarks) != 0 {
		t.Fatalf("ListLocalBookmarks missing = (%#v, %v)", emptyBookmarks, err)
	}
	created, err := CreateLocalBookmark("feature", "chg1")
	if err != nil || created.Name != "feature" || jjCovStringPtrValue(created.TargetChangeID) != "chg1" {
		t.Fatalf("CreateLocalBookmark = (%#v, %v)", created, err)
	}
	if err := DeleteLocalBookmark("feature"); err != nil {
		t.Fatalf("DeleteLocalBookmark returned error: %v", err)
	}
	has, err := HasLocalBookmark("feature")
	if err != nil || !has {
		t.Fatalf("HasLocalBookmark feature = (%t, %v)", has, err)
	}
	has, err = HasLocalBookmark("missing")
	if err != nil || has {
		t.Fatalf("HasLocalBookmark missing = (%t, %v)", has, err)
	}

	changes, err := ListLocalChanges(0)
	if err != nil || len(changes) != 2 || changes[1].Description != "desc\twith tab" {
		t.Fatalf("ListLocalChanges = (%#v, %v)", changes, err)
	}
	if parsed := parseRevisionLine("chg\tcommit\tdescription\twith-tab"); parsed.ChangeID != "chg" || parsed.CommitID != "commit" || parsed.Description != "description\twith-tab" {
		t.Fatalf("parseRevisionLine = %#v", parsed)
	}
	revision, err := GetLocalRevision("@", LocalReadOptions{IgnoreWorkingCopy: true})
	if err != nil || revision.ChangeID != "wc123" || revision.CommitID != "commit-wc" {
		t.Fatalf("GetLocalRevision = (%#v, %v)", revision, err)
	}
	if _, err := GetLocalRevision("empty", LocalReadOptions{}); err == nil || !strings.Contains(err.Error(), "Unable to resolve revision empty") {
		t.Fatalf("GetLocalRevision empty error = %v", err)
	}
	current, err := CurrentLocalChangeID()
	if err != nil || current != "wc123" {
		t.Fatalf("CurrentLocalChangeID = (%q, %v)", current, err)
	}

	stackIDs, err := ListLocalStackChangeIDs(`main"target`)
	if err != nil || !reflect.DeepEqual(stackIDs, []string{"chg1", "chg2"}) {
		t.Fatalf("ListLocalStackChangeIDs = (%#v, %v)", stackIDs, err)
	}
	stackChanges, err := ListLocalStackChanges("main")
	if err != nil || len(stackChanges) != 2 || stackChanges[0].Description != "Full description for chg1" {
		t.Fatalf("ListLocalStackChanges = (%#v, %v)", stackChanges, err)
	}
	if err := SetLocalBookmark("feature", "chg1"); err != nil {
		t.Fatalf("SetLocalBookmark returned error: %v", err)
	}
	t.Setenv("GITHUB_TOKEN", "github-token")
	if err := PushLocalBookmark("feature"); err != nil {
		t.Fatalf("PushLocalBookmark returned error: %v", err)
	}
	if err := FetchGitRemote(); err != nil {
		t.Fatalf("FetchGitRemote returned error: %v", err)
	}
	if err := RebaseLocalChange("chg1", "main"); err != nil {
		t.Fatalf("RebaseLocalChange returned error: %v", err)
	}

	changeText, err := GetLocalChange("chg1")
	if err != nil || !strings.Contains(changeText, "Feature change") {
		t.Fatalf("GetLocalChange = (%q, %v)", changeText, err)
	}
	details, err := GetLocalChangeDetails("chg1")
	if err != nil || details.ChangeID != "chg1" {
		t.Fatalf("GetLocalChangeDetails = (%#v, %v)", details, err)
	}
	diff, err := GetLocalDiff("chg1")
	if err != nil || diff != "diff for chg1" {
		t.Fatalf("GetLocalDiff = (%q, %v)", diff, err)
	}
	files, err := ListLocalChangeFiles("chg1")
	if err != nil || !reflect.DeepEqual(files, []string{"file.go", "conflict.txt"}) {
		t.Fatalf("ListLocalChangeFiles = (%#v, %v)", files, err)
	}
	conflicts, err := ListLocalChangeConflicts("chg1")
	if err != nil || !reflect.DeepEqual(conflicts, []string{"conflict.txt"}) {
		t.Fatalf("ListLocalChangeConflicts = (%#v, %v)", conflicts, err)
	}
	status, err := GetLocalStatus(LocalReadOptions{IgnoreWorkingCopy: true})
	if err != nil || status.WorkingCopy.ChangeID != "wc123" || status.Parent.ChangeID != "parent1" || len(status.Files) != 2 {
		t.Fatalf("GetLocalStatus = (%#v, %v)", status, err)
	}

	if entry := parseDiffSummaryLine("M   spaced.go"); entry == nil || entry.Status != "M" || entry.Path != "spaced.go" {
		t.Fatalf("parseDiffSummaryLine valid = %#v", entry)
	}
	if entry := parseDiffSummaryLine("not a summary"); entry != nil {
		t.Fatalf("parseDiffSummaryLine invalid = %#v", entry)
	}
	if entries := listDiffSummaryEntries("\nA added.go\nbad\nC conflicted.go\n"); len(entries) != 2 || entries[1].Path != "conflicted.go" {
		t.Fatalf("listDiffSummaryEntries = %#v", entries)
	}
	if lines := nonEmptyLines(" one \n\n two \n"); !reflect.DeepEqual(lines, []string{"one", "two"}) {
		t.Fatalf("nonEmptyLines = %#v", lines)
	}
	if lines := nonEmptyLines(" \n\t "); len(lines) != 0 {
		t.Fatalf("nonEmptyLines blank = %#v", lines)
	}

	rawLog, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	log := string(rawLog)
	for _, want := range []string{
		"log -n 10",
		"git push --bookmark feature",
		`user.email="ada@example.com"`,
		"rebase --revisions chg1 --onto main",
	} {
		if !strings.Contains(log, want) {
			t.Fatalf("jj log missing %q:\n%s", want, log)
		}
	}
}
