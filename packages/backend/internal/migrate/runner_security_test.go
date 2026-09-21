package migrate

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// runAtlas embeds the full argv (including the DSN) in its error text, which
// lands in CI/release logs when a Helm migration hook fails. The password must
// never appear in that text.
func TestRunner_Security_RunAtlasErrorRedactsDSNPassword(t *testing.T) {
	stubDir := t.TempDir()
	stubPath := filepath.Join(stubDir, "atlas")
	stubScript := "#!/bin/sh\necho atlas failed >&2\nexit 42\n"
	require.NoError(t, os.WriteFile(stubPath, []byte(stubScript), 0o755))
	t.Setenv("PATH", stubDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	err := runAtlas(context.Background(),
		"migrate", "apply",
		"--url", "postgres://admin:hunter2secret@db.internal:5432/plue",
		"--dir", "file:///migrations",
	)
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "hunter2secret", "error text must not leak the DSN password")
	assert.Contains(t, err.Error(), "postgres://admin")
	assert.Contains(t, err.Error(), "db.internal")
	assert.Contains(t, err.Error(), "exit status 42")
}

func TestRunner_Security_RedactURLCredentials(t *testing.T) {
	for _, arg := range []string{
		"postgres://admin:secret%zz@db/plue",
		"postgres://db/plue?password=secret",
		"--url=postgres://admin:secret@db/plue",
		"postgres://db/plue?sslpassword=secret",
	} {
		assert.NotContains(t, redactURLCredentials(arg), "secret")
	}
	assert.Equal(t,
		"postgres://admin@db.internal/plue",
		redactURLCredentials("postgres://admin:hunter2secret@db.internal/plue"),
		"password stripped, username kept")
	assert.Equal(t,
		"postgres://db.internal/plue",
		redactURLCredentials("postgres://db.internal/plue"),
		"no userinfo: unchanged")
	assert.Equal(t,
		"postgres://admin@db.internal/plue",
		redactURLCredentials("postgres://admin@db.internal/plue"),
		"username-only userinfo: unchanged")
	assert.Equal(t, "migrate", redactURLCredentials("migrate"), "non-URL arg: unchanged")
	assert.Equal(t, "file:///migrations", redactURLCredentials("file:///migrations"), "file URI: unchanged")
}
