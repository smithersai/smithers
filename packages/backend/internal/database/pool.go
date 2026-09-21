package database

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/config"
)

// DBPoolStatsObserver receives periodic database connection pool statistics.
type DBPoolStatsObserver interface {
	SetDBConnectionsActive(n float64)
	SetDBConnectionsMax(n float64)
}

// NewPool creates a pgxpool.Pool with the spec-required configuration.
func NewPool(ctx context.Context, cfg config.DatabaseConfig, metrics ...DBQueryDurationObserver) (*pgxpool.Pool, error) {
	poolCfg, err := pgxpool.ParseConfig(cfg.URL)
	if err != nil {
		return nil, fmt.Errorf("parse database config: %w", err)
	}

	poolCfg.MaxConns = cfg.MaxConns
	poolCfg.MinConns = cfg.MinConns
	poolCfg.MaxConnLifetime = time.Duration(cfg.MaxConnLifetime) * time.Second
	poolCfg.MaxConnIdleTime = time.Duration(cfg.MaxConnIdleTime) * time.Second
	poolCfg.AfterConnect = func(_ context.Context, conn *pgx.Conn) error {
		ConfigureSQLCTypes(conn.TypeMap())
		return nil
	}
	if len(metrics) > 0 && metrics[0] != nil {
		poolCfg.ConnConfig.Tracer = NewMetricsTracer(metrics[0])
	}

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}

	return pool, nil
}

// ConfigureSQLCTypes keeps generated string fields compatible with native
// PostgreSQL types. pgx 5.9 added a binary tsvector codec, while sqlc maps this
// schema's search vectors to strings. Registering the field as text preserves
// prepared statements and binary handling for JSON and all other native types.
func ConfigureSQLCTypes(typeMap *pgtype.Map) {
	typeMap.RegisterType(&pgtype.Type{
		Name:  "tsvector",
		OID:   pgtype.TSVectorOID,
		Codec: pgtype.TextCodec{},
	})
}

// StartPoolStatsCollector runs a background goroutine that periodically reads
// pool statistics from pgxpool.Pool and reports them to the observer. The
// goroutine exits when the provided context is canceled.
func StartPoolStatsCollector(ctx context.Context, pool *pgxpool.Pool, observer DBPoolStatsObserver, interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				stat := pool.Stat()
				observer.SetDBConnectionsActive(float64(stat.AcquiredConns()))
				observer.SetDBConnectionsMax(float64(stat.MaxConns()))
				slog.Debug("db pool stats collected", "acquired", stat.AcquiredConns(), "max", stat.MaxConns())
			}
		}
	}()
}
