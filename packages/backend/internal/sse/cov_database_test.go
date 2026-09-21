package sse

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

// PostgreSQL readiness for the DB-backed tests in this package.
//
// The broker, handler, and listener tests each assert behavior under 2-5s
// deadlines: a NOTIFY reaches a subscriber, a killed backend closes the
// stream, a broker reconnects. Those deadlines used to also cover the test's
// own infrastructure work (first TCP connect through a container port
// forward, CREATE DATABASE on a cold server, one bootstrap pool per test),
// which under a loaded host or a fresh PostgreSQL takes longer than 5s on
// its own and failed every DB-backed test before any behavior ran. Setup
// now happens once per package under its own readiness budget, with
// retries, and per-test pools connect under a separate budget; the
// behavioral deadlines are unchanged.

const (
	// covSetupBudget bounds the one-time database preparation (reachability
	// plus CREATE DATABASE when missing). It is a readiness wait, not an
	// assertion: a server that is not up within it fails the package with
	// the last connection error.
	covSetupBudget = 90 * time.Second
	// covConnectBudget bounds opening one test pool, retrying the ping so a
	// single stalled connection attempt (per-attempt covAttemptTimeout) is
	// replaced by a fresh one instead of failing the test.
	covConnectBudget  = 30 * time.Second
	covAttemptTimeout = 5 * time.Second
	covRetryDelay     = 250 * time.Millisecond
	// covStimulusBudget bounds the test's own NOTIFY publication. A NOTIFY
	// commits through the WAL, so on a shared server it waits behind every
	// other session's WAL flush (observed: 170-470ms per round trip under
	// load, 5.9s worst case, and minutes while another suite's DROP SCHEMA
	// CASCADE held the WALWrite lock). The 2s it used to share with the
	// delivery assertion bounded that flush, not the stream under test; the
	// delivery wait after publication is unchanged.
	covStimulusBudget = 30 * time.Second

	pgCodeInvalidCatalogName = "3D000" // database does not exist
	pgCodeDuplicateDatabase  = "42P04" // database already exists
)

var (
	covDatabaseOnce sync.Once
	covDatabaseErr  error
)

func covDatabaseURL() string {
	dsn := os.Getenv("SMITHERS_TEST_DATABASE_URL")
	if dsn == "" {
		return "postgres://smithers:smithers@localhost:5432/cx_sse?sslmode=disable"
	}
	return dsn
}

// covPrepareDatabase skips under -short and otherwise guarantees, once per
// package, that the test database exists and accepts connections.
func covPrepareDatabase(t *testing.T) {
	t.Helper()
	if testing.Short() {
		t.Skip("requires PostgreSQL; covered by DB Integration")
	}
	covDatabaseOnce.Do(func() {
		covDatabaseErr = covEnsureDatabase(covDatabaseURL())
	})
	require.NoError(t, covDatabaseErr, "prepare the sse test database")
}

func covPgCode(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}

// covEnsureDatabase connects to dsn, creating its database when the server
// reports it missing, until it succeeds or covSetupBudget elapses.
func covEnsureDatabase(dsn string) error {
	deadline := time.Now().Add(covSetupBudget)
	var lastErr error
	for {
		err := covTryConnect(dsn)
		if err == nil {
			return nil
		}
		lastErr = err
		if covPgCode(err) == pgCodeInvalidCatalogName {
			if createErr := covCreateDatabase(dsn); createErr != nil && covPgCode(createErr) != pgCodeDuplicateDatabase {
				lastErr = createErr
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("sse test database not ready within %s: %w", covSetupBudget, lastErr)
		}
		time.Sleep(covRetryDelay)
	}
}

func covTryConnect(dsn string) error {
	ctx, cancel := context.WithTimeout(context.Background(), covAttemptTimeout)
	defer cancel()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	return conn.Ping(ctx)
}

func covCreateDatabase(dsn string) error {
	parsed, err := url.Parse(dsn)
	if err != nil {
		return err
	}
	dbName := strings.TrimPrefix(parsed.Path, "/")
	if dbName == "" {
		return errors.New("sse test database URL has no database name")
	}
	parsed.Path = "/postgres"

	// CREATE DATABASE copies a template and, on a cold or busy server, takes
	// several seconds on its own; bound it by the setup budget's attempt
	// slice rather than the behavioral deadlines.
	ctx, cancel := context.WithTimeout(context.Background(), covSetupBudget/3)
	defer cancel()
	conn, err := pgx.Connect(ctx, parsed.String())
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{dbName}.Sanitize())
	return err
}

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
	cfg, err := pgxpool.ParseConfig(covDatabaseURL())
	require.NoError(t, err)
	return cfg
}

// covNotify publishes payload on channel through pool and fails the test
// when the server does not commit it within covStimulusBudget.
func covNotify(t *testing.T, pool *pgxpool.Pool, channel, payload string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), covStimulusBudget)
	defer cancel()
	start := time.Now()
	_, err := pool.Exec(ctx, "select pg_notify($1, $2)", channel, payload)
	require.NoErrorf(t, err, "publishing the NOTIFY stimulus took %s: the PostgreSQL server is stalled, not the stream under test", time.Since(start).Round(time.Millisecond))
}
