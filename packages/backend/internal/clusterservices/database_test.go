package clusterservices

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/database"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// Cluster integration tests use an explicitly provisioned, isolated database.
func setupTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("SMITHERS_CLUSTER_TEST_DATABASE_URL")
	if raw == "" {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("SMITHERS_CLUSTER_TEST_DATABASE_URL is required")
		}
		t.Skip("set SMITHERS_CLUSTER_TEST_DATABASE_URL for cluster database integration")
	}
	cfg, err := pgxpool.ParseConfig(raw)
	require.NoError(t, err)
	cfg.AfterConnect = func(_ context.Context, conn *pgx.Conn) error { database.ConfigureSQLCTypes(conn.TypeMap()); return nil }
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	require.NoError(t, pool.Ping(context.Background()))
	return pool
}

func getAgentTestPool(t *testing.T) *pgxpool.Pool { return setupTestPool(t) }
func httpStatus(err error) int {
	var apiErr *pkgerrors.APIError
	if errors.As(err, &apiErr) {
		return apiErr.Status
	}
	return 0
}
func apiStatus(t *testing.T, err error) int {
	t.Helper()
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	return apiErr.Status
}

type deleteWorkspaceProvider struct {
	sandbox.Provider
	deleteVMFn func(context.Context, string) error
}

func (p *deleteWorkspaceProvider) DeleteSandbox(ctx context.Context, id string) error {
	return p.deleteVMFn(ctx, id)
}

type workspaceMetricsRecorder struct{ addActiveVMsFn func(string, float64) }

func (m *workspaceMetricsRecorder) ObserveSandboxVMCreate(string, string, float64) {}
func (m *workspaceMetricsRecorder) AddSandboxActiveVMs(kind string, delta float64) {
	m.addActiveVMsFn(kind, delta)
}
func (m *workspaceMetricsRecorder) ObserveSandboxVMSuspend(float64) {}
