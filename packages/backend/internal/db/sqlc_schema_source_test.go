package db

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSQLCConfigSchemaSource_RemainsDeterministic(t *testing.T) {
	configPath := findSQLCConfigPath(t)
	configBytes, err := os.ReadFile(configPath)
	require.NoError(t, err)
	configText := string(configBytes)

	assert.Contains(t, configText, `schema: "cluster/sqlc_schema.sql"`)

	schemaPath := filepath.Join(filepath.Dir(configPath), "cluster", "sqlc_schema.sql")
	_, err = os.Stat(schemaPath)
	require.NoError(t, err)

	cmd := exec.Command("python3", filepath.Join(filepath.Dir(configPath), "generate_schema.py"), "--check")
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
	productConfig, err := os.ReadFile(filepath.Join(filepath.Dir(configPath), "product", "sqlc.yaml"))
	require.NoError(t, err)
	assert.Contains(t, string(productConfig), `schema: "migrations/"`)
}

func findSQLCConfigPath(t *testing.T) string {
	t.Helper()
	candidates := []string{
		filepath.Join("..", "..", "db", "sqlc.yaml"),
		filepath.Join("db", "sqlc.yaml"),
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			abs, absErr := filepath.Abs(candidate)
			require.NoError(t, absErr)
			return abs
		}
	}
	t.Fatalf("could not locate db/sqlc.yaml from cwd %s", mustGetwd(t))
	return ""
}

func mustGetwd(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	require.NoError(t, err)
	return strings.TrimSpace(wd)
}
