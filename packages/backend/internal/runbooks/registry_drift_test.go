package runbooks

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// TestRegistryMatchesPlue fails when the embedded copy drifts from Plue's
// registry, which owns the alert policies. Set SMITHERS_PLUE_DIR to the Plue
// checkout; the test skips when no checkout is found.
func TestRegistryMatchesPlue(t *testing.T) {
	dir := os.Getenv("SMITHERS_PLUE_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skip("no home directory to locate a Plue checkout")
		}
		dir = filepath.Join(home, "plue")
	}
	upstream, err := os.ReadFile(filepath.Join(dir, "docs", "runbooks", "registry.json"))
	if os.IsNotExist(err) {
		t.Skipf("no Plue checkout at %s; set SMITHERS_PLUE_DIR", dir)
	}
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(upstream, RegistryJSON) {
		t.Fatalf("packages/backend/internal/runbooks/registry.json differs from %s/docs/runbooks/registry.json; copy Plue's file", dir)
	}
}
