package database

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

// poolCoverStatsObserver is a goroutine-safe DBPoolStatsObserver stub that
// records how many times each setter was invoked and the last value seen.
type poolCoverStatsObserver struct {
	mu         sync.Mutex
	activeN    int
	maxN       int
	lastActive float64
	lastMax    float64
}

func TestPool_ConfigureSQLCTypesUsesTextForTSVector(t *testing.T) {
	t.Parallel()

	typeMap := pgtype.NewMap()
	ConfigureSQLCTypes(typeMap)

	tsvectorType, ok := typeMap.TypeForOID(pgtype.TSVectorOID)
	require.True(t, ok)
	assert.Equal(t, int16(pgtype.TextFormatCode), tsvectorType.Codec.PreferredFormat())

	var decoded string
	require.NoError(t, typeMap.Scan(pgtype.TSVectorOID, pgtype.TextFormatCode, []byte("'smithers':1A"), &decoded))
	assert.Equal(t, "'smithers':1A", decoded)
}

func (o *poolCoverStatsObserver) SetDBConnectionsActive(n float64) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.activeN++
	o.lastActive = n
}

func (o *poolCoverStatsObserver) SetDBConnectionsMax(n float64) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.maxN++
	o.lastMax = n
}

func (o *poolCoverStatsObserver) counts() (int, int) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.activeN, o.maxN
}

func (o *poolCoverStatsObserver) lastValues() (float64, float64) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.lastActive, o.lastMax
}

// TestPool_NewPool_ParseConfigError verifies that an unparseable database URL
// surfaces a wrapped "parse database config" error.
func TestPool_NewPool_ParseConfigError(t *testing.T) {
	t.Parallel()

	cfg := config.DatabaseConfig{
		URL:             "postgres://localhost:abc/db", // invalid port -> parse failure
		MaxConns:        4,
		MinConns:        1,
		MaxConnLifetime: 60,
		MaxConnIdleTime: 30,
	}

	pool, err := NewPool(context.Background(), cfg)
	require.Error(t, err)
	assert.Nil(t, pool)
	assert.Contains(t, err.Error(), "parse database config")
}

// TestPool_NewPool_CreatePoolError verifies that an invalid pool configuration
// (MaxConns == 0) fails inside pgxpool.NewWithConfig and surfaces a wrapped
// "create pool" error. The URL itself parses fine; only pool construction fails.
func TestPool_NewPool_CreatePoolError(t *testing.T) {
	t.Parallel()

	cfg := config.DatabaseConfig{
		URL:             "postgres://smithers:smithers@127.0.0.1:5432/x?sslmode=disable",
		MaxConns:        0, // pgxpool requires MaxConns >= 1
		MinConns:        0,
		MaxConnLifetime: 60,
		MaxConnIdleTime: 30,
	}

	pool, err := NewPool(context.Background(), cfg)
	require.Error(t, err)
	assert.Nil(t, pool)
	assert.Contains(t, err.Error(), "create pool")
}

// TestPool_NewPool_PingError verifies that a valid config pointing at a port
// with no server surfaces a wrapped "ping database" error. Parsing and lazy
// pool construction succeed; only the eager Ping fails.
func TestPool_NewPool_PingError(t *testing.T) {
	t.Parallel()

	cfg := config.DatabaseConfig{
		// Port 1 has no Postgres server; connection is refused quickly.
		URL:             "postgres://smithers:smithers@127.0.0.1:1/x?sslmode=disable&connect_timeout=2",
		MaxConns:        2,
		MinConns:        0,
		MaxConnLifetime: 60,
		MaxConnIdleTime: 30,
	}

	pool, err := NewPool(context.Background(), cfg)
	require.Error(t, err)
	assert.Nil(t, pool)
	assert.Contains(t, err.Error(), "ping database")
}

// TestPool_NewPool_NilMetricsVariadic verifies that passing an explicit nil
// metrics observer does not attach a tracer and still succeeds.
func TestPool_NewPool_NilMetricsVariadic(t *testing.T) {
	databaseURL := testdb.New(t).URL

	cfg := config.DatabaseConfig{
		URL:             databaseURL,
		MaxConns:        3,
		MinConns:        1,
		MaxConnLifetime: 60,
		MaxConnIdleTime: 30,
	}

	// Explicit nil observer exercises the `metrics[0] != nil` guard's false branch.
	pool, err := NewPool(context.Background(), cfg, nil)
	require.NoError(t, err)
	require.NotNil(t, pool)
	t.Cleanup(pool.Close)

	var one int
	require.NoError(t, pool.QueryRow(context.Background(), "SELECT 1").Scan(&one))
	assert.Equal(t, 1, one)
}

// TestPool_StartPoolStatsCollector_ReportsAndStops verifies that the background
// collector reports pool statistics on each tick and that canceling the context
// stops the goroutine.
func TestPool_StartPoolStatsCollector_ReportsAndStops(t *testing.T) {
	databaseURL := testdb.New(t).URL

	cfg := config.DatabaseConfig{
		URL:             databaseURL,
		MaxConns:        5,
		MinConns:        1,
		MaxConnLifetime: 60,
		MaxConnIdleTime: 30,
	}

	pool, err := NewPool(context.Background(), cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	observer := &poolCoverStatsObserver{}
	ctx, cancel := context.WithCancel(context.Background())

	StartPoolStatsCollector(ctx, pool, observer, 5*time.Millisecond)

	// At least one tick must fire, exercising the ticker.C branch, pool.Stat(),
	// and both observer setters.
	require.Eventually(t, func() bool {
		active, max := observer.counts()
		return active >= 1 && max >= 1
	}, 2*time.Second, 5*time.Millisecond)

	_, lastMax := observer.lastValues()
	assert.Equal(t, float64(cfg.MaxConns), lastMax, "reported max connections must match pool config")

	// Cancel to exercise the ctx.Done() return branch and stop the goroutine.
	cancel()

	// After cancellation the counters must stop advancing.
	time.Sleep(30 * time.Millisecond)
	activeAfterCancel, maxAfterCancel := observer.counts()
	time.Sleep(30 * time.Millisecond)
	activeFinal, maxFinal := observer.counts()

	assert.Equal(t, activeAfterCancel, activeFinal, "active collection must stop after context cancel")
	assert.Equal(t, maxAfterCancel, maxFinal, "max collection must stop after context cancel")
}
