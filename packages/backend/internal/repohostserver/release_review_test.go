package repohostserver

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Promoted from reviews/release-2026-09-13/evidence/path_repro.go.txt
// (findings R014 and R015). Both tests build native history with jj and call
// the production inspector against the exported git store.

func reviewJJ(t *testing.T, dir string, args ...string) string {
	t.Helper()
	common := []string{"--config", "user.name=Release Review", "--config", "user.email=review@example.invalid", "--repository", dir}
	out, err := exec.Command("jj", append(common, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("jj %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func reviewPathFixture(t *testing.T, deleteFile bool) (string, map[string]string, map[string]string) {
	t.Helper()
	requireNativeLaneTools(t)
	dir := filepath.Join(t.TempDir(), "fixture")
	if out, err := exec.Command("jj", "git", "init", "--no-colocate", dir).CombinedOutput(); err != nil {
		t.Fatalf("init: %v: %s", err, out)
	}
	file := filepath.Join(dir, "protected.txt")
	if err := os.WriteFile(file, []byte("original\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	reviewJJ(t, dir, "describe", "-m", "base")
	reviewJJ(t, dir, "bookmark", "create", "main", "-r", "@")
	old := reviewJJ(t, dir, "log", "-r", "@", "--no-graph", "-T", "commit_id")
	reviewJJ(t, dir, "new")
	var err error
	if deleteFile {
		err = os.Remove(file)
	} else {
		err = os.WriteFile(file, []byte("unauthorized replacement\n"), 0o600)
	}
	if err != nil {
		t.Fatal(err)
	}
	reviewJJ(t, dir, "describe", "-m", "out of lane")
	reviewJJ(t, dir, "bookmark", "set", "main", "-r", "@")
	reviewJJ(t, dir, "git", "export")
	newID := reviewJJ(t, dir, "log", "-r", "@", "--no-graph", "-T", "commit_id")
	return filepath.Join(dir, ".jj", "repo", "store", "git"), map[string]string{"refs/heads/main": old}, map[string]string{"refs/heads/main": newID}
}

func TestReleaseReviewPathLaneRejectsDeletion(t *testing.T) {
	dir, before, after := reviewPathFixture(t, true)
	if err := enforcePushPathAllowlist(context.Background(), dir, before, after, []string{"src/**"}); err == nil {
		t.Fatal("path-limited push deleting protected.txt was accepted")
	}
}

func TestReleaseReviewCancelledInspectionRestoresRefs(t *testing.T) {
	dir, before, after := reviewPathFixture(t, false)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := enforcePushPathAllowlist(ctx, dir, before, after, []string{"src/**"})
	if err == nil {
		t.Fatal("cancelled inspection unexpectedly succeeded")
	}
	refs, readErr := listGitRefs(context.Background(), dir)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if refs["refs/heads/main"] != before["refs/heads/main"] {
		t.Fatalf("inspection failed but unauthorized main ref remained published: %v", err)
	}
}
