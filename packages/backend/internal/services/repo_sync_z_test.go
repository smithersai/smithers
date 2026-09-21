package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRepoSync_Z_DefaultRootRunGitAndErrorBranches(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	svc := NewRepoSyncService(" ", repoSyncZConnectionChecker{connected: true})
	assert.Equal(t, defaultRepoSyncRoot, svc.root)

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	err := svc.runGit(cancelled, "--version")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "git --version")

	err = svc.runGit(ctx, "definitely-not-a-git-command-z")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "definitely-not-a-git-command-z")

	svc = NewRepoSyncService(t.TempDir(), nil)
	err = svc.SyncRepo(ctx, 1, "owner", "repo", RepoSyncRequest{WorkingCopyParent: RepoSyncWorkingCopyParent{CommitID: "c"}})
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewRepoSyncService(t.TempDir(), repoSyncZConnectionChecker{err: errors.New("connection failed")})
	err = svc.SyncRepo(ctx, 1, "owner", "repo", RepoSyncRequest{WorkingCopyParent: RepoSyncWorkingCopyParent{CommitID: "c"}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "connection failed")

	svc = NewRepoSyncService(t.TempDir(), repoSyncZConnectionChecker{connected: false})
	err = svc.SyncRepo(ctx, 1, "owner", "repo", RepoSyncRequest{WorkingCopyParent: RepoSyncWorkingCopyParent{CommitID: "c"}})
	assert.Equal(t, 403, apiStatus(t, err))

	svc = NewRepoSyncService(t.TempDir(), repoSyncZConnectionChecker{connected: true})
	svc.runGit = func(context.Context, ...string) error { return errors.New("init failed") }
	err = svc.SyncRepo(ctx, 1, "owner", "repo", RepoSyncRequest{WorkingCopyParent: RepoSyncWorkingCopyParent{CommitID: "c"}})
	assert.Equal(t, 500, apiStatus(t, err))

	root := t.TempDir()
	repoPath := filepath.Join(root, "owner", "repo.git")
	require.NoError(t, os.MkdirAll(repoPath, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(repoPath, "jj"), []byte("not a dir"), 0o644))
	svc = NewRepoSyncService(root, repoSyncZConnectionChecker{connected: true})
	err = svc.SyncRepo(ctx, 1, "owner", "repo", RepoSyncRequest{WorkingCopyParent: RepoSyncWorkingCopyParent{CommitID: "c"}})
	assert.Equal(t, 500, apiStatus(t, err))

	err = ensureBareRepoExists(ctx, func(context.Context, ...string) error { return nil }, "bad\x00path")
	require.Error(t, err)
}

func TestRepoSync_Z_WriteJSONAtomicallyErrors(t *testing.T) {
	t.Parallel()

	tmp := t.TempDir()
	parentFile := filepath.Join(tmp, "parent-file")
	require.NoError(t, os.WriteFile(parentFile, []byte("x"), 0o644))
	require.Error(t, writeJSONAtomically(filepath.Join(parentFile, "metadata.json"), map[string]string{"x": "y"}))

	require.Error(t, writeJSONAtomically(filepath.Join(tmp, "bad-marshal.json"), make(chan int)))

	if os.Geteuid() != 0 {
		readOnlyDir := filepath.Join(tmp, "read-only")
		require.NoError(t, os.Mkdir(readOnlyDir, 0o555))
		t.Cleanup(func() { _ = os.Chmod(readOnlyDir, 0o755) })
		err := writeJSONAtomically(filepath.Join(readOnlyDir, "metadata.json"), map[string]string{"x": "y"})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "permission denied")
	}

	dirPath := filepath.Join(tmp, "existing-dir")
	require.NoError(t, os.Mkdir(dirPath, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dirPath, "child"), []byte("x"), 0o644))
	err := writeJSONAtomically(dirPath, map[string]string{"x": "y"})
	require.Error(t, err)
}

// Regression for the shared PID-scoped temp file: concurrent writes to the same
// destination must each use their own temp file, so every call succeeds, the
// final metadata is exactly one caller's complete payload, and no temp files
// are left behind.
func TestRepoSync_Z_WriteJSONAtomicallyConcurrentSameDestination(t *testing.T) {
	t.Parallel()

	tmp := t.TempDir()
	path := filepath.Join(tmp, "metadata.json")

	const writers = 16
	payloads := make([]map[string]string, writers)
	errs := make([]error, writers)
	var wg sync.WaitGroup
	for i := range writers {
		payloads[i] = map[string]string{"writer": fmt.Sprintf("%d", i)}
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = writeJSONAtomically(path, payloads[i])
		}()
	}
	wg.Wait()

	for i, err := range errs {
		require.NoError(t, err, "writer %d", i)
	}

	got, err := os.ReadFile(path)
	require.NoError(t, err)
	winner := false
	for _, payload := range payloads {
		want, err := json.MarshalIndent(payload, "", "  ")
		require.NoError(t, err)
		if string(got) == string(want)+"\n" {
			winner = true
			break
		}
	}
	assert.True(t, winner, "final metadata must be one complete payload, got: %s", got)

	entries, err := os.ReadDir(tmp)
	require.NoError(t, err)
	for _, entry := range entries {
		assert.False(t, strings.HasSuffix(entry.Name(), ".tmp"), "leftover temp file %s", entry.Name())
	}
}

type repoSyncZConnectionChecker struct {
	connected bool
	err       error
}

func (c repoSyncZConnectionChecker) GetRepoConnectionStatus(context.Context, int64, string, string) (RepoConnectionStatus, error) {
	if c.err != nil {
		return RepoConnectionStatus{}, c.err
	}
	return RepoConnectionStatus{Connected: c.connected}, nil
}
