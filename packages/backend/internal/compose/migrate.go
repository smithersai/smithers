package compose

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/migrate"
)

// defaultMigrationsDir is the canonical SQL source in the public Go package.
// Distribution images copy this tree at the same relative path.
const defaultMigrationsDir = "packages/backend/db/migrations"

// migrateAtlasApply and migrateAtlasStatus are seams so tests can drive
// runMigrate's dispatch and failure-exit paths without a real atlas binary or a
// live database. Production keeps the real Atlas exec paths.
var (
	migrateAtlasApply  = migrate.RunAtlasApply
	migrateAtlasStatus = migrate.RunAtlasStatus
)

// runMigrate implements the `smithers-api migrate [apply|status] [-dir]`
// subcommand. It applies (or reports the status of) the Atlas migrations in the
// migrations directory against the configured database and returns the result.
//
// It deliberately does NOT boot the HTTP server, call config.Load, or run
// ValidateServerStartup: the migration path needs only a database URL, so the
// Job can drop every validator-only secret. A non-nil return propagates to
// exitCodeFor -> a non-zero process exit, which fails the Helm migration hook
// and blocks the rollout on an unapplied/failed schema change.
//
// Env inputs (no config file, no validator secrets):
//   - SMITHERS_ATLAS_URL, else SMITHERS_DATABASE_URL — the target database.
//   - SMITHERS_MIGRATIONS_DIR — overrides the migrations directory (also -dir).
func runMigrate(ctx context.Context, args []string, stderr io.Writer) error {
	fs := flag.NewFlagSet("smithers-api migrate", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dirFlag := fs.String("dir", "", "Path to the Atlas migrations directory (default: $SMITHERS_MIGRATIONS_DIR or "+defaultMigrationsDir+")")

	// Pull an optional leading subcommand ("apply"|"status") off before flag
	// parsing so both `migrate status` and `migrate status -dir X` work. A
	// leading token that begins with "-" is treated as a flag, not a subcommand.
	sub := "apply"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub = args[0]
		args = args[1:]
	}
	if err := fs.Parse(args); err != nil {
		return &flagParseError{err}
	}
	if fs.NArg() > 0 {
		return &flagParseError{fmt.Errorf("migrate: unexpected argument %q", fs.Arg(0))}
	}
	switch sub {
	case "apply", "status":
		// ok
	default:
		return &flagParseError{fmt.Errorf("migrate: unknown subcommand %q (want apply or status)", sub)}
	}

	env, err := migrateAtlasEnv()
	if err != nil {
		return err
	}
	migrationsDir := resolveMigrationsDir(*dirFlag)

	if sub == "status" {
		return migrateAtlasStatus(ctx, env, migrationsDir)
	}
	return migrateAtlasApply(ctx, env, migrationsDir)
}

// migrateAtlasEnv builds the apply-only Atlas connection settings from the
// environment. Unlike migrate.LoadAtlasEnv it does NOT require
// SMITHERS_ATLAS_DEV_URL (that dev database is only used by `atlas migrate diff`,
// never by apply/status), so the migration Job needs no dev database.
func migrateAtlasEnv() (migrate.AtlasEnv, error) {
	url := strings.TrimSpace(os.Getenv("SMITHERS_ATLAS_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("SMITHERS_DATABASE_URL"))
	}
	if url == "" {
		return migrate.AtlasEnv{}, fmt.Errorf("migrate: SMITHERS_ATLAS_URL or SMITHERS_DATABASE_URL is required")
	}
	return migrate.AtlasEnv{URL: url}, nil
}

// resolveMigrationsDir picks the migrations directory: explicit -dir flag, then
// SMITHERS_MIGRATIONS_DIR, then the bundled default.
func resolveMigrationsDir(flagValue string) string {
	if v := strings.TrimSpace(flagValue); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv("SMITHERS_MIGRATIONS_DIR")); v != "" {
		return v
	}
	return defaultMigrationsDir
}
