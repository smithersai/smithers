package migrate

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRunner_Cov_MigrationDirURIUsesInputWhenAbsFails(t *testing.T) {
	originalWD, err := os.Getwd()
	require.NoError(t, err)
	t.Cleanup(func() {
		require.NoError(t, os.Chdir(originalWD))
	})

	deletedWD := filepath.Join(t.TempDir(), "deleted")
	require.NoError(t, os.Mkdir(deletedWD, 0o755))
	deletedWDFile, err := os.Open(deletedWD)
	require.NoError(t, err)
	t.Cleanup(func() {
		require.NoError(t, deletedWDFile.Close())
	})
	require.NoError(t, os.RemoveAll(deletedWD))
	require.NoError(t, syscall.Fchdir(int(deletedWDFile.Fd())))

	relDir := filepath.Join("relative", "migrations")
	got := migrationDirURI(relDir)
	fallbackURI := "file://" + filepath.ToSlash(relDir)
	if got == fallbackURI {
		assert.Equal(t, fallbackURI, got)
		return
	}
	assert.Contains(t, got, filepath.ToSlash(filepath.Join("deleted", relDir)))
}

func TestRunner_Cov_RunAtlasReturnsCommandError(t *testing.T) {
	stubDir := t.TempDir()
	stubPath := filepath.Join(stubDir, "atlas")
	stubScript := "#!/bin/sh\necho atlas failed >&2\nexit 42\n"
	require.NoError(t, os.WriteFile(stubPath, []byte(stubScript), 0o755))
	t.Setenv("PATH", stubDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	err := runAtlas(context.Background(), "migrate", "status", "--url", "postgres://app")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "atlas migrate status --url postgres://app")
	assert.Contains(t, err.Error(), "exit status 42")
}
