package product

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/database"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

// newProductTestPool opens a pool on an empty database that exists for the
// duration of the test.
func newProductTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	config, err := pgxpool.ParseConfig(testdb.New(t).URL)
	if err != nil {
		t.Fatal(err)
	}
	config.AfterConnect = func(_ context.Context, conn *pgx.Conn) error {
		database.ConfigureSQLCTypes(conn.TypeMap())
		return nil
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// A migration that waits behind a long transaction must give up quickly
// instead of queueing every later query on the locked table.
func TestApplyGivesUpOnLockWait(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	if err := Apply(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM smithers_product_migrations WHERE version = 14; DROP TABLE recommendation_logs`); err != nil {
		t.Fatal(err)
	}

	oldTimeout, oldAttempts, oldBackoff := migrationLockTimeout, migrationLockAttempts, migrationLockBackoff
	migrationLockTimeout, migrationLockAttempts, migrationLockBackoff = 200*time.Millisecond, 2, 10*time.Millisecond
	t.Cleanup(func() {
		migrationLockTimeout, migrationLockAttempts, migrationLockBackoff = oldTimeout, oldAttempts, oldBackoff
	})

	holder, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Rollback(ctx) }()
	if _, err := holder.Exec(ctx, `LOCK TABLE smithers_product_migrations IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}

	applyCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	started := time.Now()
	err = Apply(applyCtx, pool)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
		t.Fatalf("Apply behind a held lock = %v after %s, want lock_not_available", err, time.Since(started))
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("Apply waited %s behind a held lock", elapsed)
	}

	if err := holder.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	pending, err := Status(ctx, pool)
	if err != nil || !slices.Equal(pending, []int{14}) {
		t.Fatalf("Status = %v, %v; want [14]", pending, err)
	}
	if err := Apply(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if pending, err := Status(ctx, pool); err != nil || len(pending) != 0 {
		t.Fatalf("Status after apply = %v, %v", pending, err)
	}
}
