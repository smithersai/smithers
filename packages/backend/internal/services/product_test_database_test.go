package services

import (
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// newProductTestPool exercises the public product migration in an
// isolated database, independent of the hosted integration schema and fences.
func newProductTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	return pool
}
