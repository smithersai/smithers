package postgresfixture

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/database"
)

// NewProductDatabase creates an isolated real PostgreSQL database, applies the
// product schema, and drops the database when the test finishes.
func NewProductDatabase(t *testing.T, raw string) (*pgxpool.Pool, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	adminURL, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	adminURL.Path = "/postgres"
	admin, err := pgx.Connect(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	name := "smithers_product_" + hex.EncodeToString(suffix[:])
	if _, err := admin.Exec(ctx, `CREATE DATABASE "`+name+`" TEMPLATE template0 ENCODING 'UTF8'`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer closeCancel()
		if _, err := admin.Exec(closeCtx, `DROP DATABASE "`+name+`" WITH (FORCE)`); err != nil {
			t.Errorf("drop product test database: %v", err)
		}
		_ = admin.Close(closeCtx)
	})
	dbURL := *adminURL
	dbURL.Path = "/" + name
	poolConfig, err := pgxpool.ParseConfig(dbURL.String())
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.AfterConnect = func(_ context.Context, conn *pgx.Conn) error {
		database.ConfigureSQLCTypes(conn.TypeMap())
		return nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := product.Apply(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool, dbURL.String()
}
