package product

import (
	"context"
	"crypto/rand"
	"encoding/csv"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Product SQLC models scan SELECT * in column order. The hosted schema is
// composed from the same product migrations and must have identical columns.
func TestProductColumnsMatchHostedOrder(t *testing.T) {
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
	t.Cleanup(func() { _ = admin.Close(ctx) })
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	prefix := "smithers_parity_" + hex.EncodeToString(suffix[:])
	openTestDB := func(kind string) *pgx.Conn {
		t.Helper()
		name := prefix + "_" + kind
		if _, err := admin.Exec(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if _, err := admin.Exec(ctx, `DROP DATABASE "`+name+`" WITH (FORCE)`); err != nil {
				t.Errorf("drop %s: %v", name, err)
			}
		})
		dbURL := *adminURL
		dbURL.Path = "/" + name
		conn, err := pgx.Connect(ctx, dbURL.String())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close(ctx) })
		return conn
	}
	product := openTestDB("product")
	productPool, err := pgxpool.New(ctx, product.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(productPool.Close)
	if err := Apply(ctx, productPool); err != nil {
		t.Fatal(err)
	}
	hosted := openTestDB("hosted")
	schema, err := os.ReadFile("../cluster/sqlc_schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hosted.Exec(ctx, string(schema)); err != nil {
		t.Fatalf("apply hosted schema: %v", err)
	}
	manifest, err := os.Open("../ownership.csv")
	if err != nil {
		t.Fatal(err)
	}
	defer manifest.Close()
	rows, err := csv.NewReader(manifest).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows[1:] {
		if len(row) < 2 || row[1] != "product" {
			continue
		}
		table := row[0]
		got := tableColumns(t, ctx, product, table)
		want := tableColumns(t, ctx, hosted, table)
		if !slices.Equal(got, want) {
			t.Errorf("%s SELECT * column order differs: product=%v hosted=%v", table, got, want)
		}
	}
}

func tableColumns(t *testing.T, ctx context.Context, conn *pgx.Conn, table string) []string {
	t.Helper()
	rows, err := conn.Query(ctx, `SELECT column_name FROM information_schema.columns
		WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, table)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var columns []string
	for rows.Next() {
		var column string
		if err := rows.Scan(&column); err != nil {
			t.Fatal(err)
		}
		columns = append(columns, column)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(fmt.Errorf("%s columns: %w", table, err))
	}
	return columns
}
