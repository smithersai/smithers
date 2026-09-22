package sandbox

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type meteringCovBillingReporter struct {
	mu      sync.Mutex
	records []UsageRecord
	err     error
}

func (r *meteringCovBillingReporter) ReportUsage(_ context.Context, records []UsageRecord) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.records = append(r.records, records...)
	return r.err
}

func (r *meteringCovBillingReporter) snapshot() []UsageRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]UsageRecord(nil), r.records...)
}

func TestMetering_Cov_StopTimerFlushAllAndBilling(t *testing.T) {
	pool := meteringCovOpenPool(t)
	meteringCovResetTables(t, pool)

	reporter := &meteringCovBillingReporter{err: errors.New("billing unavailable")}
	service := NewMeteringService(pool, reporter, meteringCovLogger(), nil)

	record, err := service.StopTimer(context.Background(), "metering-cov-missing")
	require.NoError(t, err)
	assert.Nil(t, record)

	service.StartTimer("metering-cov-vm-one", "metering-cov-ws-one", 7101, 0, 2, 2048)
	service.StartTimer("metering-cov-vm-one", "metering-cov-ws-replacement", 9999, 0, 8, 8192)
	assert.Equal(t, 1, service.ActiveTimerCount())

	service.mu.Lock()
	service.timers["metering-cov-vm-one"].startedAt = time.Now().Add(-2 * time.Minute)
	service.mu.Unlock()

	record, err = service.StopTimer(context.Background(), "metering-cov-vm-one")
	require.NoError(t, err)
	require.NotNil(t, record)
	assert.Equal(t, "metering-cov-ws-one", record.WorkspaceID)
	assert.Equal(t, int32(2), record.VCPUs)
	assert.GreaterOrEqual(t, record.ComputeMinutes(), 3.9)
	assert.Equal(t, 0, service.ActiveTimerCount())

	reported := reporter.snapshot()
	require.Len(t, reported, 1)
	assert.Equal(t, "metering-cov-vm-one", reported[0].VMID)

	var persistedMinutes float64
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT compute_minutes FROM sandbox_usage WHERE vm_id = $1`,
		"metering-cov-vm-one",
	).Scan(&persistedMinutes))
	assert.InDelta(t, record.ComputeMinutes(), persistedMinutes, 0.05)

	service.StartTimer("metering-cov-vm-two", "metering-cov-ws-two", 7102, 0, 1, 1024)
	service.StartTimer("metering-cov-vm-three", "metering-cov-ws-three", 7103, 0, 1, 1024)
	service.mu.Lock()
	service.timers["metering-cov-vm-two"].startedAt = time.Now().Add(-time.Minute)
	service.timers["metering-cov-vm-three"].startedAt = time.Now().Add(-time.Minute)
	service.mu.Unlock()

	require.NoError(t, service.FlushAll(context.Background()))
	assert.Equal(t, 0, service.ActiveTimerCount())

	var flushed int
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM sandbox_usage WHERE vm_id IN ('metering-cov-vm-two', 'metering-cov-vm-three')`,
	).Scan(&flushed))
	assert.Equal(t, 2, flushed)
}

func TestMetering_Cov_CheckQuotaUserOrgAndErrors(t *testing.T) {
	pool := meteringCovOpenPool(t)
	meteringCovResetTables(t, pool)

	ctx := context.Background()
	meteringCovUpsertUser(t, pool, 7201, 0)
	meteringCovUpsertUser(t, pool, 7202, 20)
	meteringCovUpsertOrg(t, pool, 7301, 3)
	meteringCovInsertUsage(t, pool, "metering-cov-user-unlimited", "metering-cov-ws-user-unlimited", 7201, 0, 15, time.Now().UTC())
	meteringCovInsertUsage(t, pool, "metering-cov-user-active", "metering-cov-ws-user-active", 7202, 0, 5, time.Now().UTC())
	meteringCovInsertUsage(t, pool, "metering-cov-user-old", "metering-cov-ws-user-old", 7202, 0, 100, time.Now().UTC().AddDate(0, -2, 0))
	meteringCovInsertUsage(t, pool, "metering-cov-org-exceeded", "metering-cov-ws-org-exceeded", 9999, 7301, 4, time.Now().UTC())

	service := NewMeteringService(pool, nil, meteringCovLogger(), nil)
	service.StartTimer("metering-cov-vm-active-user", "metering-cov-ws-active-user", 7202, 0, 2, 1024)
	service.StartTimer("metering-cov-vm-active-org", "metering-cov-ws-active-org", 8888, 7301, 1, 1024)
	service.mu.Lock()
	service.timers["metering-cov-vm-active-user"].startedAt = time.Now().Add(-time.Minute)
	service.timers["metering-cov-vm-active-org"].startedAt = time.Now().Add(-time.Minute)
	service.mu.Unlock()

	unlimited, err := service.CheckQuota(ctx, 7201, 0)
	require.NoError(t, err)
	assert.Equal(t, int64(7201), unlimited.UserID)
	assert.Equal(t, float64(0), unlimited.QuotaMinutes)
	assert.False(t, unlimited.Exceeded)
	assert.GreaterOrEqual(t, unlimited.UsedMinutes, 15.0)

	userStatus, err := service.CheckQuota(ctx, 7202, 0)
	require.NoError(t, err)
	assert.Equal(t, int64(7202), userStatus.UserID)
	assert.Equal(t, float64(20), userStatus.QuotaMinutes)
	assert.False(t, userStatus.Exceeded)
	assert.Greater(t, userStatus.UsedMinutes, 6.9)
	assert.Greater(t, userStatus.RemainingMinutes, 0.0)

	orgStatus, err := service.CheckQuota(ctx, 0, 7301)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "compute quota exceeded")
	require.NotNil(t, orgStatus)
	assert.Equal(t, int64(7301), orgStatus.OrgID)
	assert.True(t, orgStatus.Exceeded)
	assert.LessOrEqual(t, orgStatus.RemainingMinutes, 0.0)

	_, err = service.CheckQuota(ctx, 7999, 0)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "query quota")

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = service.CheckQuota(cancelled, 7202, 0)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "query usage for user 7202")

	_, err = service.CheckQuota(cancelled, 0, 7301)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "query usage for org 7301")
}

func TestMetering_Cov_FlushAllAndHeartbeatPaths(t *testing.T) {
	pool := meteringCovOpenPool(t)
	meteringCovResetTables(t, pool)

	service := NewMeteringService(pool, nil, meteringCovLogger(), nil)
	service.StartTimer("metering-cov-heartbeat-direct", "metering-cov-ws-heartbeat-direct", 7401, 0, 2, 2048)
	service.mu.Lock()
	service.timers["metering-cov-heartbeat-direct"].startedAt = time.Now().Add(-2 * time.Minute)
	service.mu.Unlock()

	service.flushInProgress(context.Background())

	var directMinutes float64
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT compute_minutes FROM sandbox_usage_heartbeat WHERE vm_id = $1`,
		"metering-cov-heartbeat-direct",
	).Scan(&directMinutes))
	assert.GreaterOrEqual(t, directMinutes, 3.9)

	service.StartTimer("metering-cov-heartbeat-periodic", "metering-cov-ws-heartbeat-periodic", 7402, 0, 1, 1024)
	periodicCtx, cancel := context.WithCancel(context.Background())
	service.RunPeriodicFlush(periodicCtx, 5*time.Millisecond)
	require.Eventually(t, func() bool {
		var count int
		err := pool.QueryRow(context.Background(),
			`SELECT COUNT(*) FROM sandbox_usage_heartbeat WHERE vm_id = $1`,
			"metering-cov-heartbeat-periodic",
		).Scan(&count)
		return err == nil && count == 1
	}, 5*time.Second, 10*time.Millisecond)
	cancel()
	time.Sleep(20 * time.Millisecond)

	cancelled, cancelNow := context.WithCancel(context.Background())
	cancelNow()
	service.flushInProgress(cancelled)

	failing := NewMeteringService(unreachablePool(t), nil, meteringCovLogger(), nil)
	failing.StartTimer("metering-cov-failing-flush", "metering-cov-ws-failing-flush", 7403, 0, 1, 1024)
	flushCtx, flushCancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer flushCancel()
	failing.flushInProgress(flushCtx)

	failing.StartTimer("metering-cov-failing-stop", "metering-cov-ws-failing-stop", 7404, 0, 1, 1024)
	err := failing.FlushAll(flushCtx)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "record usage")
	assert.Equal(t, 2, failing.ActiveTimerCount())
}

func meteringCovOpenPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if testing.Short() {
		t.Skip("requires PostgreSQL; covered by DB Integration")
	}
	dsn := strings.TrimSpace(os.Getenv("SMITHERS_TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("SMITHERS_TEST_DATABASE_URL is required for PostgreSQL metering tests")
	}
	parsed, err := url.Parse(dsn)
	require.NoError(t, err)
	adminURL := *parsed
	adminURL.Path = "/postgres"
	admin, err := pgx.Connect(context.Background(), adminURL.String())
	require.NoError(t, err)
	database := "smithers_metering_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	_, err = admin.Exec(context.Background(), "CREATE DATABASE "+pgx.Identifier{database}.Sanitize())
	if err != nil {
		_ = admin.Close(context.Background())
		require.NoError(t, err)
	}
	t.Cleanup(func() {
		_, cleanupErr := admin.Exec(context.Background(), "DROP DATABASE "+pgx.Identifier{database}.Sanitize()+" WITH (FORCE)")
		require.NoError(t, cleanupErr)
		require.NoError(t, admin.Close(context.Background()))
	})
	parsed.Path = "/" + database
	cfg, err := pgxpool.ParseConfig(parsed.String())
	require.NoError(t, err)
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	return pool
}

func meteringCovResetTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	_, err := pool.Exec(context.Background(), `
		CREATE EXTENSION IF NOT EXISTS "pgcrypto";
		CREATE TABLE IF NOT EXISTS users (
			id BIGINT PRIMARY KEY,
			username TEXT NOT NULL UNIQUE,
			lower_username TEXT NOT NULL UNIQUE,
			display_name TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
		CREATE TABLE IF NOT EXISTS organizations (
			id BIGINT PRIMARY KEY,
			name TEXT NOT NULL,
			lower_name TEXT NOT NULL UNIQUE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
		ALTER TABLE users ADD COLUMN IF NOT EXISTS compute_quota_minutes DOUBLE PRECISION NOT NULL DEFAULT 0;
		ALTER TABLE organizations ADD COLUMN IF NOT EXISTS compute_quota_minutes DOUBLE PRECISION NOT NULL DEFAULT 0;
		DROP TABLE IF EXISTS sandbox_usage_heartbeat;
		DROP TABLE IF EXISTS sandbox_usage;
		CREATE TABLE sandbox_usage (
			id BIGSERIAL PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			vm_id TEXT NOT NULL,
			user_id BIGINT NOT NULL,
			org_id BIGINT NOT NULL DEFAULT 0,
			started_at TIMESTAMPTZ NOT NULL,
			stopped_at TIMESTAMPTZ,
			duration_seconds BIGINT NOT NULL,
			vcpus INTEGER NOT NULL,
			memory_mb INTEGER NOT NULL,
			compute_minutes DOUBLE PRECISION NOT NULL
		);
		CREATE TABLE sandbox_usage_heartbeat (
			vm_id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			user_id BIGINT NOT NULL,
			org_id BIGINT NOT NULL DEFAULT 0,
			started_at TIMESTAMPTZ NOT NULL,
			last_seen_at TIMESTAMPTZ NOT NULL,
			duration_seconds BIGINT NOT NULL,
			vcpus INTEGER NOT NULL,
			memory_mb INTEGER NOT NULL,
			compute_minutes DOUBLE PRECISION NOT NULL
		);
		DELETE FROM users WHERE id BETWEEN 7100 AND 7999;
		DELETE FROM organizations WHERE id BETWEEN 7300 AND 7399;
	`)
	require.NoError(t, err)
}

func meteringCovUpsertUser(t *testing.T, pool *pgxpool.Pool, userID int64, quotaMinutes float64) {
	t.Helper()

	username := strings.ToLower("metering-cov-user-" + meteringCovFormatInt(userID))
	_, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, username, lower_username, display_name, compute_quota_minutes)
		 VALUES ($1, $2, $2, $3, $4)
		 ON CONFLICT (id) DO UPDATE SET compute_quota_minutes = EXCLUDED.compute_quota_minutes`,
		userID, username, "Metering Cov User", quotaMinutes,
	)
	require.NoError(t, err)
}

func meteringCovUpsertOrg(t *testing.T, pool *pgxpool.Pool, orgID int64, quotaMinutes float64) {
	t.Helper()

	name := "metering-cov-org-" + meteringCovFormatInt(orgID)
	_, err := pool.Exec(context.Background(),
		`INSERT INTO organizations (id, name, lower_name, compute_quota_minutes)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (id) DO UPDATE SET compute_quota_minutes = EXCLUDED.compute_quota_minutes`,
		orgID, name, strings.ToLower(name), quotaMinutes,
	)
	require.NoError(t, err)
}

func meteringCovInsertUsage(t *testing.T, pool *pgxpool.Pool, vmID, workspaceID string, userID, orgID int64, computeMinutes float64, startedAt time.Time) {
	t.Helper()

	_, err := pool.Exec(context.Background(),
		`INSERT INTO sandbox_usage
		 (workspace_id, vm_id, user_id, org_id, started_at, stopped_at, duration_seconds, vcpus, memory_mb, compute_minutes)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		workspaceID, vmID, userID, orgID, startedAt, startedAt.Add(time.Minute), 60, 1, 1024, computeMinutes,
	)
	require.NoError(t, err)
}

func meteringCovLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func meteringCovFormatInt(v int64) string {
	return strconv.FormatInt(v, 10)
}
