package sandbox

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

var (
	schemaSandboxTablePattern = regexp.MustCompile(`(?i)CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(sandbox_\w+)`)
	sourceSandboxTablePattern = regexp.MustCompile(`(?i)\b(?:INSERT\s+INTO|UPDATE|FROM)\s+(?:public\.)?(sandbox_\w+)`)
)

// TestSourceSandboxTablesExistInSchema refuses hand-written SQL that names a
// sandbox_ table absent from the product migrations and cluster sqlc schema.
// Tests that create their own tables hide that drift, so _test.go files are
// scanned too.
func TestSourceSandboxTablesExistInSchema(t *testing.T) {
	dbDir := filepath.Join("..", "..", "db")
	known := schemaSandboxTables(t, dbDir)
	require.NotEmpty(t, known, "no sandbox_ tables parsed from the schema")

	missing := sandboxTableReferencesOutside(t, filepath.Join(filepath.Dir(dbDir), "internal"), known)
	require.Empty(t, missing, "SQL names sandbox_ tables that no migration or sqlc schema creates")
}

func TestSandboxTableReferenceGuardFlagsUnknownTable(t *testing.T) {
	root := t.TempDir()
	fixture := "package fake\n\nconst q = `INSERT INTO " + "sandbox_usage_heartbeat (id) VALUES ($1)`\n"
	require.NoError(t, os.WriteFile(filepath.Join(root, "fake.go"), []byte(fixture), 0o600))

	missing := sandboxTableReferencesOutside(t, root, map[string]bool{"sandbox_usage_intervals": true})
	require.Equal(t, []string{"fake.go: sandbox_usage_heartbeat"}, missing)
}

func schemaSandboxTables(t *testing.T, dbDir string) map[string]bool {
	t.Helper()
	sources, err := filepath.Glob(filepath.Join(dbDir, "product", "migrations", "*.sql"))
	require.NoError(t, err)
	sources = append(sources, filepath.Join(dbDir, "cluster", "sqlc_schema.sql"))
	known := map[string]bool{}
	for _, source := range sources {
		body, err := os.ReadFile(source)
		require.NoError(t, err)
		for _, match := range schemaSandboxTablePattern.FindAllStringSubmatch(string(body), -1) {
			known[strings.ToLower(match[1])] = true
		}
	}
	return known
}

func sandboxTableReferencesOutside(t *testing.T, root string, known map[string]bool) []string {
	t.Helper()
	var missing []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, ".sql.go") {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		for _, match := range sourceSandboxTablePattern.FindAllStringSubmatch(string(body), -1) {
			if table := strings.ToLower(match[1]); !known[table] {
				missing = append(missing, filepath.ToSlash(rel)+": "+table)
			}
		}
		return nil
	})
	require.NoError(t, err)
	sort.Strings(missing)
	return compactStrings(missing)
}

func compactStrings(values []string) []string {
	out := values[:0]
	for i, value := range values {
		if i == 0 || value != values[i-1] {
			out = append(out, value)
		}
	}
	return out
}
