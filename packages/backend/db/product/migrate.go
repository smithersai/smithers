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
	{2, "migrations/0002_import_publication.sql"},
	{3, "migrations/0003_repository_creation_jobs.sql"},
	{4, "migrations/0004_single_owner_identity.sql"},
	{5, "migrations/0005_durable_product_jobs.sql"},
	{6, "migrations/0006_repository_storage_fences.sql"},
	{7, "migrations/0007_chat_turns.sql"},
	{8, "migrations/0008_flow_runtime_host_bindings.sql"},
	{9, "migrations/0009_owner_models.sql"},
	{10, "migrations/0010_branch_lock_and_workflow_invocations.sql"},
	{11, "migrations/0011_onboarding_and_workspace_setup.sql"},
	{12, "migrations/0012_workflow_run_coding_hosts.sql"},
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
	return applied, nil
}

// Status reports whether every migration supported by this binary is applied.
// A newer database or checksum drift is an error. Adoption can verify and
// record later historical product objects before pending earlier migrations
// run; Status reports incomplete until every numbered migration is present.
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
		if item.version == 12 {
			adopted, err := adoptExistingCodingHostTable(ctx, tx)
			if err != nil {
				return fmt.Errorf("adopt product migration 12: %w", err)
			}
			if adopted {
				if _, err := tx.Exec(ctx, `INSERT INTO public.smithers_product_migrations(version, checksum) VALUES ($1, $2)`, item.version, item.checksum); err != nil {
					return fmt.Errorf("record adopted product migration 12: %w", err)
				}
				continue
			}
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

// Plue's former mixed lineage already installed migration 12's table before
// Smithers owned the product ledger. Adopt only the exact canonical shape;
// a partial or different table must stop the rollout.
func adoptExistingCodingHostTable(ctx context.Context, tx pgx.Tx) (bool, error) {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT to_regclass('public.workflow_run_coding_hosts') IS NOT NULL`).Scan(&exists); err != nil {
		return false, err
	}
	if !exists {
		return false, nil
	}
	var matches bool
	err := tx.QueryRow(ctx, `SELECT
		ARRAY(SELECT a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
			FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
			WHERE a.attrelid='public.workflow_run_coding_hosts'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum)
		= ARRAY['workflow_run_id:bigint:true:', 'workspace_id:uuid:true:', 'host_run_id:text:true:', 'flow_id:text:true:',
			'created_at:timestamp with time zone:true:now()', 'updated_at:timestamp with time zone:true:now()']
		AND ARRAY(SELECT conname || ':' || pg_get_constraintdef(oid)
			FROM pg_constraint WHERE conrelid='public.workflow_run_coding_hosts'::regclass ORDER BY conname)
		= ARRAY['workflow_run_coding_hosts_flow_id_present:CHECK ((flow_id <> ''''::text))',
			'workflow_run_coding_hosts_host_run_id_present:CHECK ((host_run_id <> ''''::text))',
			'workflow_run_coding_hosts_pkey:PRIMARY KEY (workflow_run_id)',
			'workflow_run_coding_hosts_workflow_run_id_fkey:FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE',
			'workflow_run_coding_hosts_workspace_id_fkey:FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE']
		AND ARRAY(SELECT indexname || ':' || indexdef FROM pg_indexes
			WHERE schemaname='public' AND tablename='workflow_run_coding_hosts' ORDER BY indexname)
		= ARRAY['idx_workflow_run_coding_hosts_workspace:CREATE INDEX idx_workflow_run_coding_hosts_workspace ON public.workflow_run_coding_hosts USING btree (workspace_id, workflow_run_id)',
			'workflow_run_coding_hosts_pkey:CREATE UNIQUE INDEX workflow_run_coding_hosts_pkey ON public.workflow_run_coding_hosts USING btree (workflow_run_id)']`).Scan(&matches)
	if err != nil {
		return false, err
	}
	if !matches {
		return false, errors.New("preexisting workflow_run_coding_hosts differs from canonical product migration 12")
	}
	return true, nil
}
