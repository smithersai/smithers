package migrate

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestValidateMigrationDir_HasAtLeastOneVersionedFile(t *testing.T) {
	t.Run("empty directory returns error", func(t *testing.T) {
		dir := t.TempDir()
		err := ValidateMigrationDir(dir)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "at least one")
	})

	t.Run("single versioned file is accepted", func(t *testing.T) {
		dir := t.TempDir()
		writeMigrationFile(t, dir, "000001_baseline.sql")
		require.NoError(t, ValidateMigrationDir(dir))
	})
}

func TestValidateMigrationDir_RejectsDuplicateVersions(t *testing.T) {
	dir := t.TempDir()
	writeMigrationFile(t, dir, "000001_baseline.sql")
	writeMigrationFile(t, dir, "000001_duplicate.sql")

	err := ValidateMigrationDir(dir)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "duplicate")
	assert.Contains(t, err.Error(), "000001")
}

func TestValidateMigrationDir_RequiresSequentialVersionPrefix(t *testing.T) {
	dir := t.TempDir()
	writeMigrationFile(t, dir, "000001_baseline.sql")
	writeMigrationFile(t, dir, "000003_skipped.sql")

	err := ValidateMigrationDir(dir)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "sequential")
}

func writeMigrationFile(t *testing.T, dir, name string) {
	t.Helper()
	path := filepath.Join(dir, name)
	require.NoError(t, os.WriteFile(path, []byte("-- migration\n"), 0o644))
}
