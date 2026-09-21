package services

import (
	"context"
	stdErrors "errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRepoSync_Cov_ConstructorNormalizeEnsureAndWriteBranches(t *testing.T) {
	svc := NewRepoSyncService(" ", nil)
	assert.Equal(t, defaultRepoSyncRoot, svc.root)

	owner, repo, err := normalizeRepoSyncRef(" Acme ", " Demo ")
	require.NoError(t, err)
	assert.Equal(t, "acme", owner)
	assert.Equal(t, "demo", repo)

	for _, tc := range []struct {
		owner string
		repo  string
		want  string
	}{
		{"", "repo", "owner is required"},
		{"owner", "", "repository name is required"},
		{".", "repo", "owner contains invalid"},
		{"owner", "..", "repository name contains invalid"},
		{"own\\er", "repo", "owner contains invalid"},
	} {
		_, _, err := normalizeRepoSyncRef(tc.owner, tc.repo)
		require.Error(t, err)
		assert.Contains(t, err.Error(), tc.want)
	}

	root := t.TempDir()
	filePath := filepath.Join(root, "not-dir.git")
	require.NoError(t, os.WriteFile(filePath, []byte("file"), 0o644))
	err = ensureBareRepoExists(context.Background(), func(context.Context, ...string) error { return nil }, filePath)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not a directory")

	err = ensureBareRepoExists(context.Background(), func(context.Context, ...string) error {
		return stdErrors.New("git failed")
	}, filepath.Join(root, "new.git"))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "git failed")

	err = writeJSONAtomically(filepath.Join(root, "bad.json"), func() {})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unsupported")
}

func TestRepoSync_Cov_SyncRepoFilesystemError(t *testing.T) {
	rootFile := filepath.Join(t.TempDir(), "root-file")
	require.NoError(t, os.WriteFile(rootFile, []byte("x"), 0o644))
	svc := NewRepoSyncService(rootFile, &mockRepoSyncConnectionChecker{})

	err := svc.SyncRepo(context.Background(), 7, "acme", "demo", RepoSyncRequest{
		WorkingCopyParent: RepoSyncWorkingCopyParent{CommitID: "abc"},
	})
	require.Error(t, err)
	assert.True(t, strings.Contains(err.Error(), "failed to create repo sync directory") || strings.Contains(err.Error(), "failed to initialize bare repository"))
}
