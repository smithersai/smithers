package clusterdb

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

type queryTxBeginner interface {
	Begin(context.Context) (pgx.Tx, error)
}

// BeginTx starts a transaction when the underlying DB handle supports it.
func (q *Queries) BeginTx(ctx context.Context) (pgx.Tx, error) {
	beginner, ok := q.db.(queryTxBeginner)
	if !ok {
		return nil, fmt.Errorf("transactions unsupported")
	}
	return beginner.Begin(ctx)
}
