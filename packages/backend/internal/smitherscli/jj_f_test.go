package smitherscli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// jjFScript is a controllable fake jj. Behavior is switched by env vars:
//
//	JJF_FAIL        substring; if the (post --ignore-working-copy) args contain
//	                it, the command fails (exit 3, stderr "jjf boom")
//	JJF_FAIL_SILENT if "1", a matched JJF_FAIL exits without writing stderr
//	JJF_EMPTY       substring; a matched command prints nothing (success)
//	JJF_BM          bookmark-list output selector: "none" | "blank" | default
const jjFScript = `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'jj 0.99.0\n'; exit 0; fi
if [ "$1" = "--ignore-working-copy" ]; then shift; fi
ARGS="$*"
if [ -n "$JJF_FAIL" ]; then
  case "$ARGS" in
    *"$JJF_FAIL"*)
      if [ "$JJF_FAIL_SILENT" = "1" ]; then exit 3; fi
      printf 'jjf boom\n' >&2
      exit 3 ;;
  esac
fi
if [ -n "$JJF_EMPTY" ]; then
  case "$ARGS" in
    *"$JJF_EMPTY"*) exit 0 ;;
  esac
fi
case "$1 $2" in
  "bookmark list")
    case "$JJF_BM" in
      none) printf 'No bookmarks found\n' ;;
      blank) printf 'main: c1 x1\nsolo:\n\nfeature: c2 x2\n' ;;
      *) printf 'main: c1 x1\nfeature: c2 x2\n' ;;
    esac
    exit 0 ;;
  "bookmark create") exit 0 ;;
  "bookmark delete") exit 0 ;;
  "bookmark set") exit 0 ;;
  "git push") exit 0 ;;
  "git fetch") exit 0 ;;
  "diff --summary") printf 'M file.go\nC conflict.txt\n'; exit 0 ;;
  "diff -r") printf 'diff body\n'; exit 0 ;;
esac
if [ "$1" = "log" ]; then
  case "$ARGS" in
    *'description ++ "\n"'*) printf 'A full description\n'; exit 0 ;;
    *'change_id ++ "\t" ++ commit_id ++ "\n"'*) printf 'chg1\tcommit1\nbad\nchg2\tcommit2\n'; exit 0 ;;
    *'change_id ++ "\n"'*) printf 'chg1\n\nchg2\n'; exit 0 ;;
    *'author.name()'*) printf 'Ada\tada@example.com\n'; exit 0 ;;
    *)
      case "$ARGS" in
        *'-n '*) printf 'chg1\tFirst\n\nchg2\tSecond\n'; exit 0 ;;
        *) printf 'chgX\tcommitX\tDesc line\n'; exit 0 ;;
      esac ;;
  esac
fi
printf 'unexpected: %s\n' "$ARGS" >&2
exit 1
`

func jjFInstall(t *testing.T) {
	t.Helper()
	binDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(binDir, "jj"), []byte(jjFScript), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestJj_F_RunJjSilentExitError(t *testing.T) {
	jjFInstall(t)
	t.Setenv("JJF_FAIL", "bookmark list marker")
	t.Setenv("JJF_FAIL_SILENT", "1")
	if _, err := runJj([]string{"bookmark", "list", "marker"}); err == nil {
		t.Fatal("runJj silent failure should error")
	}
}

func TestJj_F_BookmarkListBranches(t *testing.T) {
	jjFInstall(t)
	t.Setenv("JJF_BM", "blank")
	bms, err := ListLocalBookmarks(nil, LocalReadOptions{})
	if err != nil {
		t.Fatalf("ListLocalBookmarks blank = %v", err)
	}
	if len(bms) != 3 {
		t.Fatalf("ListLocalBookmarks blank count = %d (%#v)", len(bms), bms)
	}

	t.Setenv("JJF_FAIL", "bookmark list")
	if _, err := ListLocalBookmarks(nil, LocalReadOptions{}); err == nil {
		t.Fatal("ListLocalBookmarks error expected")
	}
	if _, err := HasLocalBookmark("x"); err == nil {
		t.Fatal("HasLocalBookmark error expected")
	}
}

func TestJj_F_CreateLocalBookmark(t *testing.T) {
	jjFInstall(t)

	// create fails
	t.Setenv("JJF_FAIL", "bookmark create")
	if _, err := CreateLocalBookmark("n", "chg1"); err == nil {
		t.Fatal("CreateLocalBookmark create error expected")
	}
	os.Unsetenv("JJF_FAIL")

	// create ok, subsequent list fails
	t.Setenv("JJF_FAIL", "bookmark list")
	if _, err := CreateLocalBookmark("n", ""); err == nil {
		t.Fatal("CreateLocalBookmark list error expected")
	}
	os.Unsetenv("JJF_FAIL")

	// create ok, list returns no bookmarks -> fallback with target
	t.Setenv("JJF_BM", "none")
	bm, err := CreateLocalBookmark("n", "chg1")
	if err != nil {
		t.Fatalf("CreateLocalBookmark fallback = %v", err)
	}
	if bm.Name != "n" || bm.TargetChangeID == nil || *bm.TargetChangeID != "chg1" {
		t.Fatalf("CreateLocalBookmark fallback bm = %#v", bm)
	}
}

func TestJj_F_LogAndRevisionErrors(t *testing.T) {
	jjFInstall(t)

	t.Setenv("JJF_FAIL", "log -n")
	if _, err := ListLocalChanges(0); err == nil {
		t.Fatal("ListLocalChanges error expected")
	}
	os.Unsetenv("JJF_FAIL")

	t.Setenv("JJF_EMPTY", "log -n")
	if changes, err := ListLocalChanges(5); err != nil || len(changes) != 0 {
		t.Fatalf("ListLocalChanges empty = %#v, %v", changes, err)
	}
	os.Unsetenv("JJF_EMPTY")

	// blank-line skip: default -n output has a blank line
	if changes, err := ListLocalChanges(5); err != nil || len(changes) != 2 {
		t.Fatalf("ListLocalChanges blank-line = %#v, %v", changes, err)
	}

	t.Setenv("JJF_FAIL", "log -r")
	if _, err := GetLocalRevision("somerev", LocalReadOptions{}); err == nil {
		t.Fatal("GetLocalRevision error expected")
	}
	if _, err := CurrentLocalChangeID(); err == nil {
		t.Fatal("CurrentLocalChangeID error expected")
	}
	if _, err := ListLocalStackChangeIDs("main"); err == nil {
		t.Fatal("ListLocalStackChangeIDs error expected")
	}
}

func TestJj_F_StackChangesInnerBranches(t *testing.T) {
	jjFInstall(t)

	// inner description lookup fails
	t.Setenv("JJF_FAIL", `description ++ "\n"`)
	if _, err := ListLocalStackChanges("main"); err == nil {
		t.Fatal("ListLocalStackChanges inner description error expected")
	}
	os.Unsetenv("JJF_FAIL")

	// inner description empty -> change skipped
	t.Setenv("JJF_EMPTY", `description ++ "\n"`)
	changes, err := ListLocalStackChanges("main")
	if err != nil {
		t.Fatalf("ListLocalStackChanges empty description = %v", err)
	}
	if len(changes) != 0 {
		t.Fatalf("ListLocalStackChanges empty description count = %d", len(changes))
	}
}

func TestJj_F_DiffSummaryErrors(t *testing.T) {
	jjFInstall(t)
	t.Setenv("JJF_FAIL", "diff --summary")
	if _, err := ListLocalChangeFiles("chg1"); err == nil {
		t.Fatal("ListLocalChangeFiles error expected")
	}
	if _, err := ListLocalChangeConflicts("chg1"); err == nil {
		t.Fatal("ListLocalChangeConflicts error expected")
	}
}

func TestJj_F_GetLocalStatusErrors(t *testing.T) {
	jjFInstall(t)

	// working copy (@) fails
	t.Setenv("JJF_FAIL", "log -r")
	if _, err := GetLocalStatus(LocalReadOptions{}); err == nil {
		t.Fatal("GetLocalStatus @ error expected")
	}
	os.Unsetenv("JJF_FAIL")

	// parent (@-) fails, @ succeeds
	t.Setenv("JJF_FAIL", "@-")
	if _, err := GetLocalStatus(LocalReadOptions{}); err == nil {
		t.Fatal("GetLocalStatus @- error expected")
	}
	os.Unsetenv("JJF_FAIL")

	// diff --summary fails, revisions succeed
	t.Setenv("JJF_FAIL", "diff --summary")
	if _, err := GetLocalStatus(LocalReadOptions{}); err == nil {
		t.Fatal("GetLocalStatus diff error expected")
	}
	os.Unsetenv("JJF_FAIL")

	// full success path
	status, err := GetLocalStatus(LocalReadOptions{IgnoreWorkingCopy: true})
	if err != nil {
		t.Fatalf("GetLocalStatus success = %v", err)
	}
	if len(status.Files) == 0 {
		t.Fatalf("GetLocalStatus files empty = %#v", status)
	}
}

func TestJj_F_PushLocalBookmarkAuthError(t *testing.T) {
	jjFInstall(t)
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("GITHUB_TOKEN", "")
	t.Setenv("SMITHERS_TOKEN", "")
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_TEST_CREDENTIAL_STORE_FILE", "")
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(configHome, "missing-auth.json"))
	if err := PushLocalBookmark("feature"); err == nil {
		t.Fatal("PushLocalBookmark should error without auth token")
	} else if !strings.Contains(err.Error(), "no token found") {
		t.Fatalf("PushLocalBookmark auth error = %v", err)
	}
}
