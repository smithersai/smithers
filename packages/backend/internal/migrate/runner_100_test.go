package migrate

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestRunner_H_MigrationDirURIUsesInputWhenAbsErrors(t *testing.T) {
	originalAbs := migrationDirAbs
	t.Cleanup(func() {
		migrationDirAbs = originalAbs
	})

	migrationDirAbs = func(dir string) (string, error) {
		if dir != "relative/migrations" {
			t.Fatalf("unexpected dir: %s", dir)
		}
		return "", errors.New("abs failed")
	}

	got := migrationDirURI("relative/migrations")
	want := "file://" + filepath.ToSlash("relative/migrations")
	if got != want {
		t.Fatalf("migrationDirURI() = %q, want %q", got, want)
	}
}
