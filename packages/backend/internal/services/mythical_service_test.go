package services

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// recordingRepoHost is a real bare repository behind repo-host's git surface
// that records every receive-pack's metadata and can fail bookmark reads.
type recordingRepoHost struct {
	*gitBackedRepoHost
	mu            sync.Mutex
	metas         []repohost.ReceivePackMetadata
	failBookmarks int
}

func (h *recordingRepoHost) ProxyReceivePack(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
	h.mu.Lock()
	h.metas = append(h.metas, meta...)
	h.mu.Unlock()
	return h.gitBackedRepoHost.ProxyReceivePack(ctx, owner, repo, stdin, stdout, meta...)
}

func (h *recordingRepoHost) ListBookmarks(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
	h.mu.Lock()
	fail := h.failBookmarks > 0
	if fail {
		h.failBookmarks--
	}
	h.mu.Unlock()
	if fail {
		return nil, "", errors.New("repo-host unavailable")
	}
	return h.gitBackedRepoHost.ListBookmarks(ctx, owner, repo, cursor, limit)
}

type mythicalServiceFixture struct {
	*gitFixture
	host    *recordingRepoHost
	hostDir string
	service *MythicalService
	pool    MythicalStore
	repoID  int64
	userID  int64
}

func newMythicalServiceFixture(t *testing.T) *mythicalServiceFixture {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	pool := newProductTestPool(t)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	f := &gitFixture{t: t, root: root, work: filepath.Join(root, "work")}
	f.git(root, "init", "-q", "--initial-branch=main", f.work)
	hostDir := f.bare("host.git")
	host := &recordingRepoHost{gitBackedRepoHost: &gitBackedRepoHost{t: t, dir: hostDir}}
	ctx := context.Background()
	var userID, repoID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('smithers-canary', 'smithers-canary') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name, default_bookmark) VALUES ($1, 'smithers', 'smithers', 'main') RETURNING id`, userID).Scan(&repoID))
	service := NewMythicalService(pool, host)
	service.scratchRoot = filepath.Join(root, "scratch")
	return &mythicalServiceFixture{gitFixture: f, host: host, hostDir: hostDir, service: service, pool: pool, repoID: repoID, userID: userID}
}

// publish pushes the work repository's main to the host, as GitHub main
// arriving through the main pull would.
func (f *mythicalServiceFixture) publish() string {
	f.git(f.work, "push", "-q", "--force", f.hostDir, "main:refs/heads/main")
	return f.git(f.work, "rev-parse", "HEAD")
}

func (f *mythicalServiceFixture) hostRef(ref string) string {
	out, err := exec.Command("git", "--git-dir", f.hostDir, "rev-parse", "--verify", "--quiet", ref).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func (f *mythicalServiceFixture) hostTree(commit string) string {
	return f.git(f.hostDir, "rev-parse", commit+"^{tree}")
}

func (f *mythicalServiceFixture) poll() db.MythicalStack {
	f.t.Helper()
	require.NoError(f.t, f.service.PollOnce(context.Background()))
	row, err := db.New(f.pool).GetMythicalStack(context.Background(), f.repoID)
	require.NoError(f.t, err)
	return row
}

func TestMythicalServiceBootstrapsFoldsAndServesTheSnapshot(t *testing.T) {
	f := newMythicalServiceFixture(t)
	ctx := context.Background()
	f.commit("✨ feat: one", "a.txt", "a")
	f.commit("✨ feat: two", "b.txt", "b")
	main := f.publish()

	absent, err := f.service.Snapshot(ctx, f.repoID, "smithers-canary/smithers", main)
	require.NoError(t, err)
	assert.Equal(t, "absent", absent.State)

	_, err = f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, false)
	require.NoError(t, err)
	row := f.poll()
	require.Equal(t, "active", row.State, row.LastError)
	tip := f.hostRef(repohost.MythicalBookmarkRef)
	require.NotEmpty(t, tip)
	assert.Equal(t, tip, row.TipCommit)
	assert.Equal(t, f.hostTree(main), f.hostTree(tip), "the stack's tree is main's")
	assert.Equal(t, main, row.LandedMain)
	assert.Equal(t, f.hostRef(repohost.MythicalNotesRef), row.NotesCommit)
	assert.NotEqual(t, main, tip, "the stack is its own history, never main's commits")
	for _, meta := range f.host.metas {
		assert.True(t, meta.ControlPlane, "every stack write is a control-plane push")
	}
	note := f.git(f.hostDir, "notes", "--ref=mythical", "show", tip)
	assert.Contains(t, note, "folded: "+main)

	// An outside commit reaches main; the stack folds it with exactly its tree.
	outside := f.commit("🔧 chore: outside", "c.txt", "c")
	f.publish()
	f.service.MainMoved(ctx, f.repoID)
	row = f.poll()
	require.Equal(t, "active", row.State, row.LastError)
	assert.Equal(t, outside, row.LandedMain)
	folded := f.hostRef(repohost.MythicalBookmarkRef)
	assert.Equal(t, f.hostTree(outside), f.hostTree(folded))
	assert.Equal(t, tip, f.git(f.hostDir, "rev-parse", folded+"^"), "folds only append")
	assert.Equal(t, outside, f.hostRef("refs/heads/main"), "main is never written")

	view, err := f.service.Snapshot(ctx, f.repoID, "smithers-canary/smithers", outside)
	require.NoError(t, err)
	assert.Equal(t, "active", view.State)
	assert.False(t, view.MainBehind)
	require.NotNil(t, view.Tip)
	assert.Equal(t, folded, view.Tip.CommitID)
	require.Len(t, view.Changes, 3)
	assert.Equal(t, "🔧 chore: outside", view.Changes[0].Title)
	assert.Equal(t, "fold", view.Changes[0].Kind)
	assert.Equal(t, "bootstrap", view.Changes[2].Kind)
	encoded, err := json.Marshal(view)
	require.NoError(t, err)
	assert.Contains(t, string(encoded), `"mainBehind":false`)
	assert.Len(t, view.Lanes, 2)

	// Nothing to do is a no-op run that writes nothing.
	f.service.MainMoved(ctx, f.repoID)
	again := f.poll()
	assert.Equal(t, folded, again.TipCommit)
	assert.Equal(t, row.Generation, again.Generation)
}

func TestMythicalServiceRecoversAPushItCouldNotConfirm(t *testing.T) {
	f := newMythicalServiceFixture(t)
	ctx := context.Background()
	f.commit("✨ feat: one", "a.txt", "a")
	main := f.publish()
	_, err := f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, false)
	require.NoError(t, err)

	// The push lands but the repository's bookmark cannot be read: the
	// prepared write stays, and nothing is finalized.
	f.host.failBookmarks = 1
	row := f.poll()
	assert.Equal(t, "bootstrapping", row.State)
	require.NotEmpty(t, row.PendingOp)
	pushed := f.hostRef(repohost.MythicalBookmarkRef)
	require.NotEmpty(t, pushed)

	// The next claim sees the refs at the prepared values and finalizes
	// without writing again.
	pushes := len(f.host.metas)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET next_attempt_at = NOW() WHERE repository_id = $1`, f.repoID)
	require.NoError(t, err)
	row = f.poll()
	require.Equal(t, "active", row.State, row.LastError)
	assert.Empty(t, row.PendingOp)
	assert.Equal(t, pushed, row.TipCommit)
	assert.Equal(t, main, row.LandedMain)
	assert.Equal(t, pushes, len(f.host.metas), "recovery never pushes twice")
}

func TestMythicalServiceFreezesWhenTheStackMovesOutsideIt(t *testing.T) {
	f := newMythicalServiceFixture(t)
	ctx := context.Background()
	f.commit("✨ feat: one", "a.txt", "a")
	f.publish()
	_, err := f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, false)
	require.NoError(t, err)
	row := f.poll()
	require.Equal(t, "active", row.State, row.LastError)

	// Someone moves the bookmark directly on the host.
	f.git(f.hostDir, "update-ref", repohost.MythicalBookmarkRef, f.hostRef("refs/heads/main"))
	f.commit("✨ feat: two", "b.txt", "b")
	f.publish()
	f.service.MainMoved(ctx, f.repoID)
	row = f.poll()
	assert.Equal(t, "frozen", row.State)
	assert.Contains(t, row.Reason, "moved outside the stack service")

	// An admin reset rebuilds the stack from main and replaces the bookmark.
	_, err = f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, true)
	require.NoError(t, err)
	row = f.poll()
	require.Equal(t, "active", row.State, row.LastError)
	assert.False(t, row.ResetRequested)
	assert.Equal(t, f.hostTree(f.hostRef("refs/heads/main")), f.hostTree(f.hostRef(repohost.MythicalBookmarkRef)))
}

func TestMythicalServiceRefusesToOverwriteAnExistingBookmark(t *testing.T) {
	f := newMythicalServiceFixture(t)
	ctx := context.Background()
	f.commit("✨ feat: one", "a.txt", "a")
	main := f.publish()
	f.git(f.hostDir, "update-ref", repohost.MythicalBookmarkRef, main)
	_, err := f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, false)
	require.NoError(t, err)
	row := f.poll()
	assert.Equal(t, "frozen", row.State)
	assert.Contains(t, row.Reason, "already exists")
	assert.Equal(t, main, f.hostRef(repohost.MythicalBookmarkRef))
}
