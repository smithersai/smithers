package migrate

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRunAtlasApply_BuildsExpectedArgs(t *testing.T) {
	argsFile := installAtlasStub(t)
	env := AtlasEnv{URL: "postgres://app:app@localhost:5432/app?sslmode=disable", DevURL: "postgres://app:app@localhost:5432/app_dev?sslmode=disable"}
	dir := t.TempDir()

	require.NoError(t, RunAtlasApply(context.Background(), env, dir))
	assert.Equal(t,
		[]string{"migrate", "apply", "--url", env.URL, "--dir", "file://" + dir},
		readStubArgs(t, argsFile),
	)
}

func TestRunAtlasStatus_BuildsExpectedArgs(t *testing.T) {
	argsFile := installAtlasStub(t)
	env := AtlasEnv{URL: "postgres://app:app@localhost:5432/app?sslmode=disable", DevURL: "postgres://app:app@localhost:5432/app_dev?sslmode=disable"}
	dir := t.TempDir()

	require.NoError(t, RunAtlasStatus(context.Background(), env, dir))
	assert.Equal(t,
		[]string{"migrate", "status", "--url", env.URL, "--dir", "file://" + dir},
		readStubArgs(t, argsFile),
	)
}

func TestRunAtlasDiff_BuildsExpectedArgs(t *testing.T) {
	argsFile := installAtlasStub(t)
	env := AtlasEnv{URL: "postgres://app:app@localhost:5432/app?sslmode=disable", DevURL: "postgres://app:app@localhost:5432/app_dev?sslmode=disable"}
	dir := t.TempDir()

	require.NoError(t, RunAtlasDiff(context.Background(), env, dir, "add_users"))
	assert.Equal(t,
		[]string{"migrate", "diff", "add_users", "--dir", "file://" + dir, "--to", env.URL, "--dev-url", env.DevURL},
		readStubArgs(t, argsFile),
	)
}

func installAtlasStub(t *testing.T) string {
	t.Helper()
	stubDir := t.TempDir()
	argsFile := filepath.Join(stubDir, "atlas-args.txt")
	stubPath := filepath.Join(stubDir, "atlas")
	stubScript := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$ATLAS_ARGS_FILE\"\n"
	require.NoError(t, os.WriteFile(stubPath, []byte(stubScript), 0o755))
	t.Setenv("ATLAS_ARGS_FILE", argsFile)
	t.Setenv("PATH", stubDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return argsFile
}

func readStubArgs(t *testing.T, path string) []string {
	t.Helper()
	b, err := os.ReadFile(path)
	require.NoError(t, err)
	trimmed := strings.TrimSpace(string(b))
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "\n")
}
