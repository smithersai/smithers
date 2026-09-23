package product

import (
	"os"
	"path"
	"slices"
	"strconv"
	"testing"
)

// A SQL file under migrations/ that is missing from migrationRegistry makes
// every fresh backend refuse to start. This test needs no database, so the
// default Go target catches the drift before any PostgreSQL test runs.
func TestMigrationRegistryMatchesMigrationDirectory(t *testing.T) {
	entries, err := os.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	var onDisk []string
	for _, entry := range entries {
		if !entry.IsDir() && path.Ext(entry.Name()) == ".sql" {
			onDisk = append(onDisk, "migrations/"+entry.Name())
		}
	}
	var registered []string
	for _, spec := range migrationRegistry {
		registered = append(registered, spec.path)
	}
	for _, file := range onDisk {
		if !slices.Contains(registered, file) {
			t.Errorf("%s is not in migrationRegistry", file)
		}
	}
	for _, spec := range migrationRegistry {
		if !slices.Contains(onDisk, spec.path) {
			t.Errorf("migrationRegistry version %d names missing file %s", spec.version, spec.path)
		}
		if want, err := strconv.Atoi(path.Base(spec.path)[:4]); err != nil || want != spec.version {
			t.Errorf("migrationRegistry version %d does not match file %s", spec.version, spec.path)
		}
	}
	loaded, err := registeredMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded) != len(onDisk) {
		t.Fatalf("registeredMigrations loaded %d of %d SQL files", len(loaded), len(onDisk))
	}
}
