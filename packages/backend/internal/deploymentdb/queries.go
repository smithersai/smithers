// Package deploymentdb composes product and cluster queries for hosted adapters.
// Product services depend only on db; this package adds no schema or model authority.
package deploymentdb

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type ProductQueries = db.Queries
type ClusterQueries = clusterdb.Queries
type Queries struct {
	*ProductQueries
	*ClusterQueries
}

func New(conn db.DBTX) *Queries                                { return &Queries{db.New(conn), clusterdb.New(conn)} }
func (q *Queries) WithTx(tx pgx.Tx) *Queries                   { return New(tx) }
func (q *Queries) BeginTx(ctx context.Context) (pgx.Tx, error) { return q.ProductQueries.BeginTx(ctx) }

// BeginTx binds both query surfaces to the same transaction.
func BeginTx(ctx context.Context, queries any) (pgx.Tx, *Queries, bool, error) {
	starter, ok := queries.(interface {
		BeginTx(context.Context) (pgx.Tx, error)
		WithTx(pgx.Tx) *Queries
	})
	if !ok {
		return nil, nil, false, nil
	}
	tx, err := starter.BeginTx(ctx)
	if err != nil {
		return nil, nil, true, err
	}
	return tx, starter.WithTx(tx), true, nil
}

// Hosted idle detection includes active gateway leases held by cluster workers.
func (q *Queries) ListIdleWorkspaces(ctx context.Context) ([]db.Workspace, error) {
	return q.ClusterQueries.ListIdleWorkspaces(ctx)
}
