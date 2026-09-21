package compose

import (
	"context"
	"errors"
	"io"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/migrate"
)

// stubbedMigrate replaces the migrateAtlasApply/migrateAtlasStatus seams with
// recorders for the duration of the test, so runMigrate's dispatch and
// failure-exit paths can be exercised without a real atlas binary or database.
type migrateRecorder struct {
	applyCalls  int
	statusCalls int
	lastEnv     migrate.AtlasEnv
	lastDir     string
	returnErr   error
}

func (r *migrateRecorder) install(t *testing.T) {
	t.Helper()
	swapVar(t, &migrateAtlasApply, func(_ context.Context, env migrate.AtlasEnv, dir string) error {
		r.applyCalls++
		r.lastEnv = env
		r.lastDir = dir
		return r.returnErr
	})
	swapVar(t, &migrateAtlasStatus, func(_ context.Context, env migrate.AtlasEnv, dir string) error {
		r.statusCalls++
		r.lastEnv = env
		r.lastDir = dir
		return r.returnErr
	})
}

func TestRunMigrate_ApplyIsDefault(t *testing.T) {
	t.Setenv("SMITHERS_ATLAS_URL", "")
	t.Setenv("SMITHERS_DATABASE_URL", "postgres://u:p@127.0.0.1:5432/db?sslmode=disable")
	t.Setenv("SMITHERS_MIGRATIONS_DIR", "")

	rec := &migrateRecorder{}
	rec.install(t)

	if err := runMigrate(context.Background(), nil, io.Discard); err != nil {
		t.Fatalf("runMigrate returned error: %v", err)
	}
	if rec.applyCalls != 1 {
		t.Fatalf("expected 1 apply call, got %d", rec.applyCalls)
	}
	if rec.statusCalls != 0 {
		t.Fatalf("expected 0 status calls, got %d", rec.statusCalls)
	}
	if rec.lastEnv.URL != "postgres://u:p@127.0.0.1:5432/db?sslmode=disable" {
		t.Fatalf("apply got unexpected URL %q", rec.lastEnv.URL)
	}
	if rec.lastDir != defaultMigrationsDir {
		t.Fatalf("apply got dir %q, want default %q", rec.lastDir, defaultMigrationsDir)
	}
}

func TestRunMigrate_StatusDispatches(t *testing.T) {
	t.Setenv("SMITHERS_DATABASE_URL", "postgres://u:p@127.0.0.1:5432/db?sslmode=disable")

	rec := &migrateRecorder{}
	rec.install(t)

	if err := runMigrate(context.Background(), []string{"status"}, io.Discard); err != nil {
		t.Fatalf("runMigrate status returned error: %v", err)
	}
	if rec.statusCalls != 1 {
		t.Fatalf("expected 1 status call, got %d", rec.statusCalls)
	}
	if rec.applyCalls != 0 {
		t.Fatalf("expected 0 apply calls, got %d", rec.applyCalls)
	}
}

func TestRunMigrate_AtlasUrlPreferredOverDatabaseUrl(t *testing.T) {
	t.Setenv("SMITHERS_ATLAS_URL", "postgres://atlas@127.0.0.1:5432/db")
	t.Setenv("SMITHERS_DATABASE_URL", "postgres://api@127.0.0.1:5432/db")

	rec := &migrateRecorder{}
	rec.install(t)

	if err := runMigrate(context.Background(), []string{"apply"}, io.Discard); err != nil {
		t.Fatalf("runMigrate returned error: %v", err)
	}
	if rec.lastEnv.URL != "postgres://atlas@127.0.0.1:5432/db" {
		t.Fatalf("expected SMITHERS_ATLAS_URL to win, got %q", rec.lastEnv.URL)
	}
}

func TestRunMigrate_DirFlagOverridesEnvAndDefault(t *testing.T) {
	t.Setenv("SMITHERS_DATABASE_URL", "postgres://u:p@127.0.0.1:5432/db")
	t.Setenv("SMITHERS_MIGRATIONS_DIR", "/env/dir")

	rec := &migrateRecorder{}
	rec.install(t)

	if err := runMigrate(context.Background(), []string{"status", "-dir", "/flag/dir"}, io.Discard); err != nil {
		t.Fatalf("runMigrate returned error: %v", err)
	}
	if rec.lastDir != "/flag/dir" {
		t.Fatalf("expected -dir flag to win, got %q", rec.lastDir)
	}
}

func TestRunMigrate_MigrationsDirEnvUsedWhenNoFlag(t *testing.T) {
	t.Setenv("SMITHERS_DATABASE_URL", "postgres://u:p@127.0.0.1:5432/db")
	t.Setenv("SMITHERS_MIGRATIONS_DIR", "/env/dir")

	rec := &migrateRecorder{}
	rec.install(t)

	if err := runMigrate(context.Background(), []string{"apply"}, io.Discard); err != nil {
		t.Fatalf("runMigrate returned error: %v", err)
	}
	if rec.lastDir != "/env/dir" {
		t.Fatalf("expected SMITHERS_MIGRATIONS_DIR to be used, got %q", rec.lastDir)
	}
}

func TestRunMigrate_UnknownSubcommandIsFlagParseError(t *testing.T) {
	// No DB URL set intentionally: the subcommand check must fail BEFORE any env
	// resolution, so a bad invocation exits 2 regardless of environment.
	t.Setenv("SMITHERS_ATLAS_URL", "")
	t.Setenv("SMITHERS_DATABASE_URL", "")

	rec := &migrateRecorder{}
	rec.install(t)

	err := runMigrate(context.Background(), []string{"bogus"}, io.Discard)
	var fpe *flagParseError
	if !errors.As(err, &fpe) {
		t.Fatalf("expected *flagParseError, got %v", err)
	}
	if got := exitCodeFor(err); got != 2 {
		t.Fatalf("expected exit code 2, got %d", got)
	}
	if rec.applyCalls != 0 || rec.statusCalls != 0 {
		t.Fatalf("atlas seams must not run on a bad subcommand: apply=%d status=%d", rec.applyCalls, rec.statusCalls)
	}
}

func TestRunMigrate_StrayPositionalIsFlagParseError(t *testing.T) {
	t.Setenv("SMITHERS_DATABASE_URL", "postgres://u:p@127.0.0.1:5432/db")

	rec := &migrateRecorder{}
	rec.install(t)

	err := runMigrate(context.Background(), []string{"apply", "extra"}, io.Discard)
	var fpe *flagParseError
	if !errors.As(err, &fpe) {
		t.Fatalf("expected *flagParseError, got %v", err)
	}
	if got := exitCodeFor(err); got != 2 {
		t.Fatalf("expected exit code 2, got %d", got)
	}
	if rec.applyCalls != 0 {
		t.Fatalf("atlas apply must not run on a stray positional, got %d calls", rec.applyCalls)
	}
}

func TestRunMigrate_MissingUrlEnvErrors(t *testing.T) {
	t.Setenv("SMITHERS_ATLAS_URL", "")
	t.Setenv("SMITHERS_DATABASE_URL", "")

	rec := &migrateRecorder{}
	rec.install(t)

	err := runMigrate(context.Background(), []string{"apply"}, io.Discard)
	if err == nil {
		t.Fatal("expected error when neither SMITHERS_ATLAS_URL nor SMITHERS_DATABASE_URL is set")
	}
	// Not a flag-parse error — a missing-config failure maps to exit 1 so the
	// Helm hook blocks the rollout rather than exiting the flag-usage code 2.
	var fpe *flagParseError
	if errors.As(err, &fpe) {
		t.Fatalf("missing URL should not be a flagParseError, got %v", err)
	}
	if got := exitCodeFor(err); got != 1 {
		t.Fatalf("expected exit code 1, got %d", got)
	}
	if rec.applyCalls != 0 {
		t.Fatalf("atlas apply must not run without a target URL, got %d calls", rec.applyCalls)
	}
}

func TestRunMigrate_ApplyErrorPropagatesToExit1(t *testing.T) {
	t.Setenv("SMITHERS_DATABASE_URL", "postgres://u:p@127.0.0.1:5432/db")

	rec := &migrateRecorder{returnErr: errors.New("atlas apply failed")}
	rec.install(t)

	err := runMigrate(context.Background(), []string{"apply"}, io.Discard)
	if err == nil {
		t.Fatal("expected apply error to propagate")
	}
	if rec.applyCalls != 1 {
		t.Fatalf("expected apply to be invoked once, got %d", rec.applyCalls)
	}
	// A propagated atlas failure must map to exit 1 — this is what fails the Helm
	// migration hook and blocks the rollout.
	if got := exitCodeFor(err); got != 1 {
		t.Fatalf("expected exit code 1, got %d", got)
	}
}
