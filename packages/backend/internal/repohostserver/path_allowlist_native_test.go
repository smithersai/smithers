package repohostserver

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// nativeLaneRepo is a real jj repository whose backing git store has the
// production layout (<root>/.jj/repo/store/git). History is written with jj
// and exported to git so the inspector sees exactly what repo-host sees after
// a push: bookmark refs plus jj's refs/jj/keep/* retention pins.
type nativeLaneRepo struct {
	t      *testing.T
	root   string
	gitDir string
}

func requireNativeLaneTools(t *testing.T) {
	t.Helper()
	for _, tool := range []string{"git", "jj"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s is not on PATH; native path-lane history tests need real %s", tool, tool)
		}
	}
}

func newNativeLaneRepo(t *testing.T) *nativeLaneRepo {
	t.Helper()
	requireNativeLaneTools(t)
	root := filepath.Join(t.TempDir(), "repo")
	if out, err := exec.Command("jj", "git", "init", "--no-colocate", root).CombinedOutput(); err != nil {
		t.Fatalf("jj git init: %v: %s", err, out)
	}
	return &nativeLaneRepo{t: t, root: root, gitDir: filepath.Join(root, ".jj", "repo", "store", "git")}
}

func (r *nativeLaneRepo) jj(args ...string) string {
	r.t.Helper()
	common := []string{
		"--config", "user.name=Lane Test",
		"--config", "user.email=lane@example.invalid",
		"--repository", r.root,
	}
	out, err := exec.Command("jj", append(common, args...)...).CombinedOutput()
	if err != nil {
		r.t.Fatalf("jj %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func (r *nativeLaneRepo) write(rel, content string) {
	r.t.Helper()
	full := filepath.Join(r.root, filepath.FromSlash(rel))
	require.NoError(r.t, os.MkdirAll(filepath.Dir(full), 0o755))
	require.NoError(r.t, os.WriteFile(full, []byte(content), 0o644))
}

func (r *nativeLaneRepo) remove(rel string) {
	r.t.Helper()
	require.NoError(r.t, os.Remove(filepath.Join(r.root, filepath.FromSlash(rel))))
}

func (r *nativeLaneRepo) rename(from, to string) {
	r.t.Helper()
	dst := filepath.Join(r.root, filepath.FromSlash(to))
	require.NoError(r.t, os.MkdirAll(filepath.Dir(dst), 0o755))
	require.NoError(r.t, os.Rename(filepath.Join(r.root, filepath.FromSlash(from)), dst))
}

func (r *nativeLaneRepo) commitID(revset string) string {
	r.t.Helper()
	return r.jj("log", "-r", revset, "--no-graph", "-T", "commit_id")
}

// export writes jj's view into the git store and returns the resulting refs,
// the same listing receivePack takes before and after git receive-pack.
func (r *nativeLaneRepo) export() map[string]string {
	r.t.Helper()
	r.jj("git", "export")
	return r.refs()
}

func (r *nativeLaneRepo) refs() map[string]string {
	r.t.Helper()
	refs, err := listGitRefs(context.Background(), r.gitDir)
	require.NoError(r.t, err)
	return refs
}

// seed publishes main = base, where base holds one in-lane and one
// out-of-lane file, and returns the exported refs.
func (r *nativeLaneRepo) seed() map[string]string {
	r.t.Helper()
	r.write("src/a.go", "package a\n")
	r.write("secret/key.txt", "k\n")
	r.jj("describe", "-m", "base")
	r.jj("bookmark", "create", "main", "-r", "@")
	return r.export()
}

var laneSrcOnly = []string{"src/**"}

func requireLaneForbidden(t *testing.T, err error, deniedPath string) {
	t.Helper()
	require.Error(t, err)
	var appErr *appError
	require.True(t, errors.As(err, &appErr), "expected *appError, got %T: %v", err, err)
	assert.Equal(t, http.StatusForbidden, appErr.StatusCode, "message: %s", appErr.Message)
	assert.Contains(t, appErr.Message, deniedPath)
}

func TestPathLaneNativeDeleteOnlyOutOfLaneDenied(t *testing.T) {
	t.Parallel()
	repo := newNativeLaneRepo(t)
	before := repo.seed()

	repo.jj("new")
	repo.remove("secret/key.txt")
	repo.jj("describe", "-m", "delete the key")
	repo.jj("bookmark", "set", "main", "-r", "@")
	after := repo.export()
	require.NotEqual(t, before["refs/heads/main"], after["refs/heads/main"])

	err := enforcePushPathAllowlist(context.Background(), repo.gitDir, before, after, laneSrcOnly)
	requireLaneForbidden(t, err, "secret/key.txt")
	assert.Equal(t, before["refs/heads/main"], repo.refs()["refs/heads/main"], "denied push must be rolled back")
}

func TestPathLaneNativeRenameOutOfLaneDenied(t *testing.T) {
	t.Parallel()
	repo := newNativeLaneRepo(t)
	before := repo.seed()

	// An exact rename: git's rename detection would report only the
	// destination path, which is inside the lane.
	repo.jj("new")
	repo.rename("secret/key.txt", "src/key.txt")
	repo.jj("describe", "-m", "move the key into the lane")
	repo.jj("bookmark", "set", "main", "-r", "@")
	after := repo.export()

	err := enforcePushPathAllowlist(context.Background(), repo.gitDir, before, after, laneSrcOnly)
	requireLaneForbidden(t, err, "secret/key.txt")
	assert.Equal(t, before["refs/heads/main"], repo.refs()["refs/heads/main"])
}

func TestPathLaneNativeInLaneAddAndDeleteAllowed(t *testing.T) {
	t.Parallel()
	repo := newNativeLaneRepo(t)
	before := repo.seed()

	repo.jj("new")
	repo.write("src/b.go", "package b\n")
	repo.remove("src/a.go")
	repo.jj("describe", "-m", "replace a with b")
	repo.jj("bookmark", "set", "main", "-r", "@")
	after := repo.export()

	require.NoError(t, enforcePushPathAllowlist(context.Background(), repo.gitDir, before, after, laneSrcOnly))
	assert.Equal(t, after["refs/heads/main"], repo.refs()["refs/heads/main"], "authorized push must stay published")
}

func TestPathLaneNativeInLaneQuotedPathAllowed(t *testing.T) {
	t.Parallel()
	repo := newNativeLaneRepo(t)
	before := repo.seed()

	// git quotes unusual path names in line-oriented output; the inspector
	// must read raw NUL-terminated paths so the lane match sees the real name.
	repo.jj("new")
	repo.write(`src/odd "name" with spaces.go`, "package odd\n")
	repo.jj("describe", "-m", "add an oddly named file")
	repo.jj("bookmark", "set", "main", "-r", "@")
	after := repo.export()

	require.NoError(t, enforcePushPathAllowlist(context.Background(), repo.gitDir, before, after, laneSrcOnly))
	assert.Equal(t, after["refs/heads/main"], repo.refs()["refs/heads/main"])
}

// mergeFixture publishes main = base and feature = base + an out-of-lane
// change, then merges feature into main. mutate runs inside the merge commit
// before it is exported so an evil merge can be produced.
func mergeFixture(t *testing.T, mutate func(*nativeLaneRepo)) (*nativeLaneRepo, map[string]string, map[string]string) {
	t.Helper()
	repo := newNativeLaneRepo(t)
	repo.seed()
	repo.jj("new", "main")
	repo.write("secret/key.txt", "rotated by a human\n")
	repo.jj("describe", "-m", "rotate the key")
	repo.jj("bookmark", "create", "feature", "-r", "@")
	before := repo.export()

	repo.jj("new", "main", "feature")
	if mutate != nil {
		mutate(repo)
	}
	repo.jj("describe", "-m", "merge feature")
	repo.jj("bookmark", "set", "main", "-r", "@")
	after := repo.export()
	return repo, before, after
}

func TestPathLaneNativeCleanMergeOfPublishedBranchAllowed(t *testing.T) {
	t.Parallel()
	repo, before, after := mergeFixture(t, nil)
	require.NoError(t, enforcePushPathAllowlist(context.Background(), repo.gitDir, before, after, laneSrcOnly))
	assert.Equal(t, after["refs/heads/main"], repo.refs()["refs/heads/main"])
}

func TestPathLaneNativeEvilMergeDenied(t *testing.T) {
	t.Parallel()
	repo, before, after := mergeFixture(t, func(r *nativeLaneRepo) {
		// Content that matches neither parent: the merge itself edits the
		// out-of-lane file.
		r.write("secret/key.txt", "smuggled in the merge\n")
	})
	err := enforcePushPathAllowlist(context.Background(), repo.gitDir, before, after, laneSrcOnly)
	requireLaneForbidden(t, err, "secret/key.txt")
	assert.Equal(t, before["refs/heads/main"], repo.refs()["refs/heads/main"])
}

func TestPathLaneNativeRewindOverOutOfLaneCommitDenied(t *testing.T) {
	t.Parallel()
	repo := newNativeLaneRepo(t)
	repo.seed()
	base := repo.commitID("@")
	repo.jj("new")
	repo.write("secret/key.txt", "rotated\n")
	repo.jj("describe", "-m", "rotate the key")
	repo.jj("bookmark", "set", "main", "-r", "@")
	before := repo.export()
	rotated := before["refs/heads/main"]
	require.NotEqual(t, base, rotated)
	require.Contains(t, before, "refs/jj/keep/"+rotated, "jj keeps a retention pin for the rotated commit")

	repo.jj("bookmark", "set", "main", "-r", base, "--allow-backwards")
	after := repo.export()
	require.Equal(t, base, after["refs/heads/main"])
	require.Contains(t, after, "refs/jj/keep/"+rotated, "the pin must not shield the dropped commit")

	err := enforcePushPathAllowlist(context.Background(), repo.gitDir, before, after, laneSrcOnly)
	requireLaneForbidden(t, err, "secret/key.txt")
	assert.Equal(t, rotated, repo.refs()["refs/heads/main"], "rewound ref must be restored")
}

func TestPathLaneNativeDeletedRefWithOutOfLaneCommitsDeniedAndRecreated(t *testing.T) {
	t.Parallel()
	repo := newNativeLaneRepo(t)
	repo.seed()
	repo.jj("new", "main")
	repo.write("secret/key.txt", "rotated\n")
	repo.jj("describe", "-m", "rotate the key")
	repo.jj("bookmark", "create", "feature", "-r", "@")
	before := repo.export()
	featureTip := before["refs/heads/feature"]
	require.NotEmpty(t, featureTip)

	repo.jj("bookmark", "delete", "feature")
	after := repo.export()
	require.NotContains(t, after, "refs/heads/feature")
	require.Contains(t, after, "refs/jj/keep/"+featureTip)

	err := enforcePushPathAllowlist(context.Background(), repo.gitDir, before, after, laneSrcOnly)
	requireLaneForbidden(t, err, "secret/key.txt")
	assert.Equal(t, featureTip, repo.refs()["refs/heads/feature"], "deleted ref must be recreated")
}

func TestPathLaneNativeDeletedRefStillReachableAllowed(t *testing.T) {
	t.Parallel()
	repo := newNativeLaneRepo(t)
	repo.seed()
	// feature points at an ancestor of main; deleting it drops no content.
	repo.jj("bookmark", "create", "feature", "-r", "main")
	repo.jj("new", "main")
	repo.write("src/b.go", "package b\n")
	repo.jj("describe", "-m", "in lane")
	repo.jj("bookmark", "set", "main", "-r", "@")
	before := repo.export()

	repo.jj("bookmark", "delete", "feature")
	after := repo.export()

	require.NoError(t, enforcePushPathAllowlist(context.Background(), repo.gitDir, before, after, laneSrcOnly))
	assert.NotContains(t, repo.refs(), "refs/heads/feature")
}

func TestPathLaneNativeInspectionFailureRestoresRefs(t *testing.T) {
	repo := newNativeLaneRepo(t)
	before := repo.seed()
	repo.jj("new")
	repo.write("src/b.go", "package b\n")
	repo.jj("describe", "-m", "in lane")
	repo.jj("bookmark", "set", "main", "-r", "@")
	after := repo.export()

	// The inspector cannot run (a broken git, a missing object, an exec
	// failure): the push must not stay published unverified.
	previous := pathInspectCommandContext
	pathInspectCommandContext = func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		return exec.CommandContext(ctx, "false")
	}
	t.Cleanup(func() { pathInspectCommandContext = previous })

	err := enforcePushPathAllowlist(context.Background(), repo.gitDir, before, after, laneSrcOnly)
	require.Error(t, err)
	var appErr *appError
	require.True(t, errors.As(err, &appErr))
	assert.Equal(t, http.StatusInternalServerError, appErr.StatusCode)
	assert.Equal(t, before["refs/heads/main"], repo.refs()["refs/heads/main"], "uninspected push must be rolled back")
}
