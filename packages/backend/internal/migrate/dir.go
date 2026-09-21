package migrate

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
)

var migrationNameRE = regexp.MustCompile(`^([0-9]{6})_.*\.sql$`)

// ValidateMigrationDir validates migration filename/version invariants.
func ValidateMigrationDir(fsRoot string) error {
	entries, err := os.ReadDir(fsRoot)
	if err != nil {
		return fmt.Errorf("read migration directory: %w", err)
	}

	versions := make(map[int]string)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		name := filepath.Base(entry.Name())
		matches := migrationNameRE.FindStringSubmatch(name)
		if len(matches) != 2 {
			continue
		}

		version, convErr := strconv.Atoi(matches[1])
		if convErr != nil {
			return fmt.Errorf("invalid migration version for %s: %w", name, convErr)
		}
		if existing, exists := versions[version]; exists {
			return fmt.Errorf("duplicate migration version %06d: %s and %s", version, existing, name)
		}
		versions[version] = name
	}

	if len(versions) == 0 {
		return fmt.Errorf("migration directory must contain at least one versioned migration file")
	}

	ordered := make([]int, 0, len(versions))
	for version := range versions {
		ordered = append(ordered, version)
	}
	slices.Sort(ordered)

	if ordered[0] != 1 {
		return fmt.Errorf("migration versions must start at 000001")
	}
	for i := 1; i < len(ordered); i++ {
		if ordered[i] != ordered[i-1]+1 {
			return fmt.Errorf("migration versions must be sequential")
		}
	}

	return nil
}
