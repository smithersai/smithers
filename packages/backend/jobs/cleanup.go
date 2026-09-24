package jobs

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

const defaultSettlementTimeout = 5 * time.Second

func settlementContext(ctx context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	if timeout <= 0 {
		timeout = defaultSettlementTimeout
	}
	return context.WithTimeout(context.WithoutCancel(ctx), timeout)
}

// A failed settlement leaves a fenced lease for durable recovery. Cleanup must
// never hold worker shutdown indefinitely when the database is unavailable.
func rollback(tx pgx.Tx) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultSettlementTimeout)
	defer cancel()
	_ = tx.Rollback(ctx)
}
