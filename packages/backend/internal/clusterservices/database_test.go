package clusterservices

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

// Cluster integration tests use an explicitly provisioned, isolated database.
func setupTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("SMITHERS_CLUSTER_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("set SMITHERS_CLUSTER_TEST_DATABASE_URL for cluster database integration")
	}
	pool, err := pgxpool.New(context.Background(), raw)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	require.NoError(t, pool.Ping(context.Background()))
	return pool
}
