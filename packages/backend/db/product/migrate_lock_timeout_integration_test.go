package product

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/url"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func newProductTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("SMITHERS_PRODUCT_TEST_DATABASE_URL")
	if raw == "" {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("SMITHERS_PRODUCT_TEST_DATABASE_URL is required")
		}
		t.Skip("set SMITHERS_PRODUCT_TEST_DATABASE_URL for PostgreSQL integration test")
	}
	ctx := context.Background()
	adminURL, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	adminURL.Path = "/postgres"
	admin, err := pgx.Connect(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	name := "smithers_product_" + hex.EncodeToString(random[:])
	if _, err := admin.Exec(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
		t.Fatal(err)
	}
	dbURL := *adminURL
	dbURL.Path = "/" + name
	pool, err := pgxpool.New(ctx, dbURL.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		if _, err := admin.Exec(ctx, `DROP DATABASE "`+name+`" WITH (FORCE)`); err != nil {
			t.Errorf("drop test database: %v", err)
		}
		_ = admin.Close(ctx)
	})
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
