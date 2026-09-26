package services

import (
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// servicesSuite is this test binary's own product database.
var servicesSuite = postgresfixture.Suite{MaxConns: 20}

func TestMain(m *testing.M) {
	os.Exit(servicesSuite.Run(m))
}

// getAgentTestPool returns the shared test pool, skipping the test (or
// failing it when database tests are required) when it is unavailable.
func getAgentTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	return servicesSuite.Pool(t)
}
