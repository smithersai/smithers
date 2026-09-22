package services

import (
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

// The required Go release job opts in so TestMain's local developer fallback
// cannot turn a failed PostgreSQL setup into a green integration run.
func TestRequiredBackendDatabaseReady(t *testing.T) {
	if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") != "1" {
		return
	}
	require.NotNil(t, agentTestDB, "required backend integration database did not initialize")
}
