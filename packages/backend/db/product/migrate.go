// Package product owns the PostgreSQL schema shared by local Smithers and Plue.
package product

import (
	"context"
	"crypto/sha256"
	"embed"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const BaselineVersion = 1

var ErrChecksumMismatch = errors.New("product migration checksum mismatch")

//go:embed migrations/0001_product_baseline.sql
var migrations embed.FS

// Status reports whether the current product baseline has been applied.
// A changed baseline is an error so operators cannot mistake drift for a
// healthy installation.
func Status(ctx context.Context, pool *pgxpool.Pool) (bool, error) {
	if pool == nil {
		return false, errors.New("product migration requires a PostgreSQL pool")
	}
	baseline, err := migrations.ReadFile("migrations/0001_product_baseline.sql")
	if err != nil {
		return false, fmt.Errorf("read product baseline: %w", err)
	}
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT to_regclass('public.smithers_product_migrations') IS NOT NULL`).Scan(&exists); err != nil {
		return false, fmt.Errorf("inspect product migration ledger: %w", err)
	}
	if !exists {
		return false, nil
	}
	var appliedChecksum string
	err = pool.QueryRow(ctx, `SELECT checksum FROM public.smithers_product_migrations WHERE version=$1`, BaselineVersion).Scan(&appliedChecksum)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read product migration ledger: %w", err)
	}
	if appliedChecksum != fmt.Sprintf("%x", sha256.Sum256(baseline)) {
		return false, fmt.Errorf("%w: version %d", ErrChecksumMismatch, BaselineVersion)
	}
	return true, nil
}

// Apply installs the product schema in one transaction. An advisory lock
// serializes concurrent app starts, and a checksum prevents silently treating
// a changed baseline as already applied. Fresh installations need only
// PostgreSQL; no Atlas executable or cloud account is involved.
func Apply(ctx context.Context, pool *pgxpool.Pool) error {
	if pool == nil {
		return errors.New("product migration requires a PostgreSQL pool")
	}
	baseline, err := migrations.ReadFile("migrations/0001_product_baseline.sql")
	if err != nil {
		return fmt.Errorf("read product baseline: %w", err)
	}
	checksum := fmt.Sprintf("%x", sha256.Sum256(baseline))
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin product migration: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
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
	var appliedChecksum string
	err = tx.QueryRow(ctx, `SELECT checksum FROM public.smithers_product_migrations WHERE version = $1`, BaselineVersion).Scan(&appliedChecksum)
	switch {
	case err == nil:
		if appliedChecksum != checksum {
			return fmt.Errorf("%w: version %d", ErrChecksumMismatch, BaselineVersion)
		}
	case errors.Is(err, pgx.ErrNoRows):
		if _, err := tx.Exec(ctx, string(baseline), pgx.QueryExecModeSimpleProtocol); err != nil {
			return fmt.Errorf("apply product baseline: %w", err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO public.smithers_product_migrations(version, checksum) VALUES ($1, $2)`, BaselineVersion, checksum); err != nil {
			return fmt.Errorf("record product baseline: %w", err)
		}
	default:
		return fmt.Errorf("read product migration ledger: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit product migration: %w", err)
	}
	return nil
}
