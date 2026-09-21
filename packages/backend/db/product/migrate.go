// Package product owns the PostgreSQL schema shared by local Smithers and Plue.
package product

import (
	"context"
	"crypto/sha256"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const BaselineVersion = 1

var (
	ErrChecksumMismatch   = errors.New("product migration checksum mismatch")
	ErrUnsupportedVersion = errors.New("product database version is newer than this binary")
	ErrMissingVersion     = errors.New("product migration ledger has a gap")
)

//go:embed migrations/*.sql
var migrations embed.FS

type migrationSpec struct {
	version int
	path    string
}

// Add each new SQL migration here in version order. Keeping the list explicit
// makes a forgotten file or an accidental deletion fail before any SQL runs.
var migrationRegistry = []migrationSpec{
	{BaselineVersion, "migrations/0001_product_baseline.sql"},
}

type migration struct {
	version  int
	sql      string
	checksum string
}

func registeredMigrations() ([]migration, error) {
	files, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return nil, fmt.Errorf("list product migrations: %w", err)
	}
	if len(files) != len(migrationRegistry) {
		return nil, fmt.Errorf("product migration registry has %d entries for %d SQL files", len(migrationRegistry), len(files))
	}
	result := make([]migration, 0, len(migrationRegistry))
	for i, spec := range migrationRegistry {
		if spec.version != i+1 || spec.path != files[i] {
			return nil, fmt.Errorf("product migration registry is not complete and ordered at version %d", i+1)
		}
		content, err := migrations.ReadFile(spec.path)
		if err != nil {
			return nil, fmt.Errorf("read product migration %d: %w", spec.version, err)
		}
		if len(content) == 0 {
			return nil, fmt.Errorf("product migration %d is empty", spec.version)
		}
		result = append(result, migration{version: spec.version, sql: string(content), checksum: fmt.Sprintf("%x", sha256.Sum256(content))})
	}
	return result, nil
}

type migrationQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func appliedMigrations(ctx context.Context, q migrationQuerier, registered []migration) (map[int]bool, error) {
	rows, err := q.Query(ctx, `SELECT version, checksum FROM public.smithers_product_migrations ORDER BY version`)
	if err != nil {
		return nil, fmt.Errorf("read product migration ledger: %w", err)
	}
	defer rows.Close()
	applied := make(map[int]bool)
	for rows.Next() {
		var version int
		var checksum string
		if err := rows.Scan(&version, &checksum); err != nil {
			return nil, fmt.Errorf("scan product migration ledger: %w", err)
		}
		if version < 1 || version > len(registered) {
			return nil, fmt.Errorf("%w: version %d", ErrUnsupportedVersion, version)
		}
		if checksum != registered[version-1].checksum {
			return nil, fmt.Errorf("%w: version %d", ErrChecksumMismatch, version)
		}
		applied[version] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read product migration ledger: %w", err)
	}
	for version := 1; version <= len(applied); version++ {
		if !applied[version] {
			return nil, fmt.Errorf("%w: version %d", ErrMissingVersion, version)
		}
	}
	return applied, nil
}

// Status reports whether every migration supported by this binary is applied.
// A newer database, checksum drift, or a ledger gap is an error.
func Status(ctx context.Context, pool *pgxpool.Pool) (bool, error) {
	if pool == nil {
		return false, errors.New("product migration requires a PostgreSQL pool")
	}
	registered, err := registeredMigrations()
	if err != nil {
		return false, err
	}
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT to_regclass('public.smithers_product_migrations') IS NOT NULL`).Scan(&exists); err != nil {
		return false, fmt.Errorf("inspect product migration ledger: %w", err)
	}
	if !exists {
		return false, nil
	}
	applied, err := appliedMigrations(ctx, pool, registered)
	if err != nil {
		return false, err
	}
	return len(applied) == len(registered), nil
}

// Apply installs every pending product migration in one transaction. An
// advisory lock serializes concurrent starts; the ledger rejects changed SQL
// and prevents an older binary from opening a newer database. Fresh installs
// need PostgreSQL only, with no Atlas executable or cloud account.
func Apply(ctx context.Context, pool *pgxpool.Pool) error {
	if pool == nil {
		return errors.New("product migration requires a PostgreSQL pool")
	}
	registered, err := registeredMigrations()
	if err != nil {
		return err
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin product migration: %w", err)
	}
	defer func() {
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(rollbackCtx)
	}()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('smithers:product:migration', 0))`); err != nil {
		return fmt.Errorf("lock product migration: %w", err)
	}
	if _, err := tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS public.smithers_product_migrations (
		version integer PRIMARY KEY,
		checksum text NOT NULL,
		applied_at timestamptz NOT NULL DEFAULT now()
	)`); err != nil {
		return fmt.Errorf("create product migration ledger: %w", err)
	}
	applied, err := appliedMigrations(ctx, tx, registered)
	if err != nil {
		return err
	}
	for _, item := range registered {
		if applied[item.version] {
			continue
		}
		if _, err := tx.Exec(ctx, item.sql, pgx.QueryExecModeSimpleProtocol); err != nil {
			return fmt.Errorf("apply product migration %d: %w", item.version, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO public.smithers_product_migrations(version, checksum) VALUES ($1, $2)`, item.version, item.checksum); err != nil {
			return fmt.Errorf("record product migration %d: %w", item.version, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit product migration: %w", err)
	}
	return nil
}
