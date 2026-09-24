package deploymentdb

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// These tests exercise the real shared policy with the hosted query adapter.
// The private fixture contains only the columns read by that adapter; product
// tables and constraints come from the real product migration lineage.
func admissionDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("SMITHERS_ADMISSION_TEST_ADMIN_URL")
	if raw == "" {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("SMITHERS_ADMISSION_TEST_ADMIN_URL is required")
		}
		t.Skip("SMITHERS_ADMISSION_TEST_ADMIN_URL is not configured")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, raw)
	require.NoError(t, err)
	name := "admission_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	_, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize())
	require.NoError(t, err)
	cfg, err := pgxpool.ParseConfig(raw)
	require.NoError(t, err)
	cfg.ConnConfig.Database = name
	cfg.MaxConns = 8
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(func() {
		pool.Close()
		_, err := admin.Exec(ctx, "DROP DATABASE "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
		require.NoError(t, err)
		require.NoError(t, admin.Close(ctx))
	})
	require.NoError(t, product.Apply(ctx, pool))
	_, err = pool.Exec(ctx, `
		CREATE TABLE storage_deletion_queue (
			allocation_key text NOT NULL, size_bytes bigint NOT NULL,
			repository_id bigint, owner_type text, owner_id bigint
		);
		CREATE TABLE repo_gateways (
			user_id bigint, deleted_at timestamptz, workspace_id uuid,
			vm_id text, status text
		)`)
	require.NoError(t, err)
	return pool
}

func admissionUser(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()
	var id int64
	name := "u" + strings.ReplaceAll(uuid.NewString(), "-", "")
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO users (username, lower_username, email, lower_email, display_name)
		VALUES ($1::text, $1::text, $1::text || '@example.test', $1::text || '@example.test', $1::text) RETURNING id`, name).Scan(&id))
	return id
}

func admissionRepo(t *testing.T, pool *pgxpool.Pool, owner int64) int64 {
	t.Helper()
	var id int64
	name := "r" + strings.ReplaceAll(uuid.NewString(), "-", "")
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO repositories (user_id, name, lower_name, is_public, default_bookmark)
		VALUES ($1, $2, $2, false, 'main') RETURNING id`, owner, name).Scan(&id))
	return id
}

func TestHostedAdmissionHoldsOwnerLockThroughPrivateRepositoryCommit(t *testing.T) {
	pool := admissionDatabase(t)
	owner := admissionUser(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	svc := services.NewBillingService(New(pool), nil, services.BillingServiceConfig{})
	var inserted int64
	err := svc.AuthorizePrivateRepoCommitted(ctx, "user", owner, func(ctx context.Context) error {
		observer, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer observer.Rollback(context.Background())
		var acquired bool
		if err := observer.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended('storage:user:' || $1::bigint::text, 0))`, owner).Scan(&acquired); err != nil {
			return err
		}
		if acquired {
			return fmt.Errorf("hosted admission did not hold the owner quota lock before the consuming write")
		}
		writer, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer writer.Rollback(context.Background())
		err = writer.QueryRow(ctx, `INSERT INTO repositories (user_id, name, lower_name, is_public, default_bookmark)
			VALUES ($1, 'committed', 'committed', false, 'main') RETURNING id`, owner).Scan(&inserted)
		if err != nil {
			return err
		}
		if err := writer.Commit(ctx); err != nil {
			return err
		}
		if err := observer.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended('storage:user:' || $1::bigint::text, 0))`, owner).Scan(&acquired); err != nil {
			return err
		}
		if acquired {
			return fmt.Errorf("hosted admission released the owner quota lock before the callback returned")
		}
		return nil
	})
	require.NoError(t, err)
	require.Positive(t, inserted)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repositories WHERE id=$1`, inserted).Scan(&count))
	require.Equal(t, 1, count)
}

func TestHostedAdmissionTransferPreservesPrivateUsageAndCallerTransaction(t *testing.T) {
	pool := admissionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	source, target := admissionUser(t, pool), admissionUser(t, pool)
	repo := admissionRepo(t, pool, source)
	targetRepo := admissionRepo(t, pool, target)
	const capBytes int64 = 100 * 1024 * 1024 * 1024
	// Paired pending/final keys are one allocation. Both source and destination
	// retained allocations must survive transaction rebinding.
	_, err := pool.Exec(ctx, `INSERT INTO storage_deletion_queue VALUES
		('source', 2, $1, 'user', $2), ('source', 2, $1, 'user', $2),
		('target', $3, $4, 'user', $5)`, repo, source, capBytes-1, targetRepo, target)
	require.NoError(t, err)
	// A separate single-connection pool proves admission reuses the caller's
	// DBTX. Opening another connection through that pool would time out.
	cfg := pool.Config().Copy()
	cfg.MaxConns = 1
	one, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	defer one.Close()
	svc := services.NewBillingService(New(one), nil, services.BillingServiceConfig{})
	tx, err := one.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(context.Background())
	// Uncommitted private usage is visible only through this exact transaction.
	_, err = tx.Exec(ctx, `UPDATE storage_deletion_queue SET size_bytes=$1 WHERE allocation_key='target'`, capBytes-1)
	require.NoError(t, err)
	called := false
	err = svc.AuthorizeRepositoryTransferCommittedInTransaction(ctx, tx, repo, "user", target, true, func(ctx context.Context) error {
		called = true
		_, err := tx.Exec(ctx, `UPDATE repositories SET description='incorrectly admitted' WHERE id=$1`, repo)
		return err
	})
	require.Error(t, err, "private retained bytes must deny this transfer")
	require.False(t, called, "quota denial must precede the consuming write")
	require.Equal(t, int32(1), one.Stat().TotalConns())
	// At the exact cap it succeeds with the same transaction; duplicate queue
	// keys must not be counted twice.
	_, err = tx.Exec(ctx, `UPDATE storage_deletion_queue SET size_bytes=$1 WHERE allocation_key='target'`, capBytes-2)
	require.NoError(t, err)
	err = svc.AuthorizeRepositoryTransferCommittedInTransaction(ctx, tx, repo, "user", target, true, func(ctx context.Context) error {
		_, err := tx.Exec(ctx, `UPDATE repositories SET description='admitted' WHERE id=$1`, repo)
		return err
	})
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	var description string
	require.NoError(t, pool.QueryRow(ctx, `SELECT description FROM repositories WHERE id=$1`, repo).Scan(&description))
	require.Equal(t, "admitted", description)
}
