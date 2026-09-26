package sse

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// PostgreSQL readiness for the DB-backed tests in this package.
//
// The broker, handler, and listener tests each assert behavior under 2-5s
// deadlines: a NOTIFY reaches a subscriber, a killed backend closes the
// stream, a broker reconnects. Those deadlines must not also cover the
// test's own infrastructure work, so TestMain creates the package's database
// once, and per-test pools connect under a separate budget with retries; the
// behavioral deadlines are unchanged.

const (
	// covConnectBudget bounds opening one test pool, retrying the ping so a
	// single stalled connection attempt (per-attempt covAttemptTimeout) is
	// replaced by a fresh one instead of failing the test.
	covConnectBudget  = 30 * time.Second
	covAttemptTimeout = 5 * time.Second
	covRetryDelay     = 250 * time.Millisecond
)

// covSuite is this package's own empty database; LISTEN/NOTIFY needs no schema.
var covSuite = postgresfixture.Suite{Empty: true}

func TestMain(m *testing.M) { os.Exit(covSuite.Run(m)) }

// covOpenPool opens a pool for cfg and proves it can serve a connection,
// retrying a failed or stalled ping with a fresh attempt until
// covConnectBudget elapses. The pool closes with the test.
func covOpenPool(t *testing.T, cfg *pgxpool.Config) *pgxpool.Pool {
	t.Helper()
	deadline := time.Now().Add(covConnectBudget)
	var lastErr error
	for {
		pool, err := covPingPool(cfg)
		if err == nil {
			t.Cleanup(pool.Close)
			return pool
		}
		lastErr = err
		if time.Now().After(deadline) {
			t.Fatalf("sse test pool not ready within %s: %v", covConnectBudget, lastErr)
		}
		time.Sleep(covRetryDelay)
	}
}

func covPingPool(cfg *pgxpool.Config) (*pgxpool.Pool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), covAttemptTimeout)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg.Copy())
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

// covPoolConfig parses the test DSN; callers adjust it before covOpenPool.
func covPoolConfig(t *testing.T) *pgxpool.Config {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(covSuite.URL(t))
	require.NoError(t, err)
	return cfg
}
