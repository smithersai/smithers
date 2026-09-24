package compose

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRunMigrate_UsesEmbeddedProductMigration(t *testing.T) {
	t.Setenv("SMITHERS_DATABASE_URL", "postgres://u:p@127.0.0.1:5432/product?sslmode=disable")
	called := 0
	old := applyProductSchema
	applyProductSchema = func(_ context.Context, pool *pgxpool.Pool) error {
		called++
		if got := pool.Config().ConnConfig.Database; got != "product" {
			t.Errorf("migration database = %q", got)
		}
		return nil
	}
	t.Cleanup(func() { applyProductSchema = old })
	if err := runMigrate(context.Background(), nil, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if called != 1 {
		t.Fatalf("product migration called %d times", called)
	}
}

func TestRunMigrate_Status(t *testing.T) {
	t.Setenv("SMITHERS_DATABASE_URL", "postgres://u:p@127.0.0.1:5432/product?sslmode=disable")
	old := productSchemaStatus
	t.Cleanup(func() { productSchemaStatus = old })
	for _, tc := range []struct {
		pending []int
		want    string
	}{{nil, "applied\n"}, {[]int{13, 14}, "pending 13 14\n"}} {
		productSchemaStatus = func(context.Context, *pgxpool.Pool) ([]int, error) { return tc.pending, nil }
		var output bytes.Buffer
		if err := runMigrate(context.Background(), []string{"status"}, &output, io.Discard); err != nil {
			t.Fatal(err)
		}
		if got := output.String(); got != tc.want {
			t.Fatalf("status = %q, want %q", got, tc.want)
		}
	}
}

func TestRunMigrate_RejectsBadInputBeforeDatabase(t *testing.T) {
	t.Setenv("SMITHERS_DATABASE_URL", "")
	for _, args := range [][]string{{"unknown"}, {"apply", "extra"}, {"status", "-dir", "old"}} {
		err := runMigrate(context.Background(), args, io.Discard, io.Discard)
		var parseErr *flagParseError
		if !errors.As(err, &parseErr) || exitCodeFor(err) != 2 {
			t.Errorf("args %v: expected flag error, got %v", args, err)
		}
	}
	if err := runMigrate(context.Background(), []string{"apply"}, io.Discard, io.Discard); err == nil || !strings.Contains(err.Error(), "SMITHERS_DATABASE_URL") {
		t.Fatalf("missing database URL: %v", err)
	}
}
