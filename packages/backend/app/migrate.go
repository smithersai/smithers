package app

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/db/product"
)

// Migrate applies the common product schema before local app startup. Plue
// controls the timing of its own cutover and can call this explicitly after
// its infrastructure migrations. The operation is transactionally serialized
// by PostgreSQL and safe for concurrent starts.
func Migrate(ctx context.Context, databaseURL string) error {
	if strings.TrimSpace(databaseURL) == "" {
		return errors.New("database URL is required")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("connect to product database: %w", err)
	}
	defer pool.Close()
	if err := product.Apply(ctx, pool); err != nil {
		return fmt.Errorf("migrate product database: %w", err)
	}
	return nil
}
