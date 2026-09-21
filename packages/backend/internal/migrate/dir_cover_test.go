package migrate

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDir_Cov_ValidateMigrationDirReadDirectoryError(t *testing.T) {
	missingDir := filepath.Join(t.TempDir(), "missing")

	err := ValidateMigrationDir(missingDir)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "read migration directory")
	assert.ErrorIs(t, err, os.ErrNotExist)
}

func TestDir_Cov_ValidateMigrationDirIgnoresDirsAndUnversionedFiles(t *testing.T) {
	t.Run("accepts valid migrations with ignored entries", func(t *testing.T) {
		dir := t.TempDir()
		require.NoError(t, os.Mkdir(filepath.Join(dir, "nested"), 0o755))
		dirCovWriteFile(t, dir, "README.md", "not a migration\n")
		dirCovWriteFile(t, dir, "000001_baseline.sql", "-- migration\n")
		dirCovWriteFile(t, dir, "000002_next.sql", "-- migration\n")

		require.NoError(t, ValidateMigrationDir(dir))
	})

	t.Run("requires first version to be one", func(t *testing.T) {
		dir := t.TempDir()
		require.NoError(t, os.Mkdir(filepath.Join(dir, "nested"), 0o755))
		dirCovWriteFile(t, dir, "README.md", "not a migration\n")
		dirCovWriteFile(t, dir, "000002_second.sql", "-- migration\n")

		err := ValidateMigrationDir(dir)
		require.Error(t, err)
		assert.EqualError(t, err, "migration versions must start at 000001")
	})
}

func TestDir_Cov_ValidateMigrationDirInvalidCapturedVersion(t *testing.T) {
	originalRE := migrationNameRE
	migrationNameRE = regexp.MustCompile(`^(bad)_.*\.sql$`)
	t.Cleanup(func() {
		migrationNameRE = originalRE
	})

	dir := t.TempDir()
	dirCovWriteFile(t, dir, "bad_migration.sql", "-- migration\n")

	err := ValidateMigrationDir(dir)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid migration version for bad_migration.sql")
	assert.Contains(t, err.Error(), "invalid syntax")
}

func dirCovWriteFile(t *testing.T, dir, name, body string) {
	t.Helper()
	require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644))
}
