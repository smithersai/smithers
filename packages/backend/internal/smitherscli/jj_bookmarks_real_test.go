package smitherscli

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestListLocalBookmarks_RealJjSkipsRemoteLinesAndDescriptions runs the real
// jj against a clone whose local main is ahead of main@origin. jj's human
// output then prints an "@origin (behind by N commits)" line under main, and
// one commit description says "no bookmarks". Neither may become a bookmark
// or empty the list.
func TestListLocalBookmarks_RealJjSkipsRemoteLinesAndDescriptions(t *testing.T) {
	if _, err := exec.LookPath("jj"); err != nil {
		t.Skip("jj is not installed")
	}
	root := t.TempDir()
	config := filepath.Join(root, "jj-config.toml")
	if err := os.WriteFile(config, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JJ_CONFIG", config)
	t.Setenv("JJ_USER", "Test")
	t.Setenv("JJ_EMAIL", "test@example.com")
	run := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("jj", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("jj %v: %v\n%s", args, err, out)
		}
	}

	origin := filepath.Join(root, "origin")
	run(root, "git", "init", "--colocate", origin)
	run(origin, "describe", "-m", "first")
	run(origin, "bookmark", "create", "main", "-r", "@")
	run(origin, "new", "-m", "second")
	clone := filepath.Join(root, "clone")
	run(root, "git", "clone", origin, clone)
	run(clone, "new", "main@origin", "-m", "this change has no bookmarks yet")
	run(clone, "bookmark", "set", "main", "-r", "@")
	run(clone, "bookmark", "create", "topic", "-r", "@")

	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(clone); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previous) })

	bookmarks, err := ListLocalBookmarks(nil, LocalReadOptions{})
	if err != nil {
		t.Fatalf("ListLocalBookmarks: %v", err)
	}
	names := map[string]LocalBookmark{}
	for _, bookmark := range bookmarks {
		names[bookmark.Name] = bookmark
	}
	if len(bookmarks) != 2 || names["main"].Name == "" || names["topic"].Name == "" {
		t.Fatalf("bookmarks = %#v, want exactly main and topic", bookmarks)
	}
	main := names["main"]
	if main.TargetChangeID == nil || len(*main.TargetChangeID) != 32 || main.TargetCommitID == nil || len(*main.TargetCommitID) != 40 {
		t.Fatalf("main target = %#v, want full change and commit ids", main)
	}
}
