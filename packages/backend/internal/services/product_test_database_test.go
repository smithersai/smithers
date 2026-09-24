package services

import (
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/testutil/postgresfixture"
)

// newProductTestPool exercises the public product migration in an
// isolated database, independent of the hosted integration schema and fences.
func newProductTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if agentTestDB == nil && os.Getenv("SMITHERS_PRODUCT_TEST_DATABASE_URL") == "" {
		t.Skip("PostgreSQL integration database is unavailable")
	}
	raw := os.Getenv("SMITHERS_PRODUCT_TEST_DATABASE_URL")
	if raw == "" {
		raw = getTestDatabaseURL()
	}
	pool, _ := postgresfixture.NewProductDatabase(t, raw)
	return pool
}
