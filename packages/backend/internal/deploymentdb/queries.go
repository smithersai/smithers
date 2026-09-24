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

// Hosted quotas include private gateway reservations as well as workspaces.
func (q *Queries) CountActiveSandboxesForUser(ctx context.Context, userID int64) (int, error) {
	return q.ClusterQueries.CountActiveSandboxesForUser(ctx, userID)
}

// Hosted resume counts the exact owned VM against the same product-plus-private
// reservation set as hosted new-slot admission. Keep the service-facing result
// typed in the canonical product model.
func (q *Queries) CountOtherActiveSandboxesForWorkspaceResume(ctx context.Context, arg db.CountOtherActiveSandboxesForWorkspaceResumeParams) (db.CountOtherActiveSandboxesForWorkspaceResumeRow, error) {
	row, err := q.ClusterQueries.CountOtherActiveSandboxesForWorkspaceResume(ctx, clusterdb.CountOtherActiveSandboxesForWorkspaceResumeParams{
		UserID: arg.UserID, WorkspaceID: arg.WorkspaceID, VmID: arg.VmID,
	})
	return db.CountOtherActiveSandboxesForWorkspaceResumeRow{Others: row.Others, Matches: row.Matches}, err
}

// Hosted suspend retains the private gateway lease fence in the same CAS.
func (q *Queries) SuspendRunningWorkspaceIfSessionless(ctx context.Context, id string) (db.Workspace, error) {
	return q.ClusterQueries.SuspendRunningWorkspaceIfSessionless(ctx, id)
}

// Hosted billing retains physical allocations while its deletion queue waits
// for object-store cleanup. The product query deliberately has no such table.
func (q *Queries) SumStorageBytesByOwner(ctx context.Context, arg db.SumStorageBytesByOwnerParams) (int64, error) {
	return q.ClusterQueries.SumStorageBytesByOwner(ctx, clusterdb.SumStorageBytesByOwnerParams{
		OwnerType: arg.OwnerType, OwnerID: arg.OwnerID,
	})
}

func (q *Queries) SumStorageBytesByRepository(ctx context.Context, repositoryID int64) (int64, error) {
	return q.ClusterQueries.SumStorageBytesByRepository(ctx, repositoryID)
}

// Product interval cleanup knows workspaces and agents. Hosted cleanup also
// reconciles gateway intervals against private gateway lifecycle state.
func (q *Queries) CloseOrphanedSandboxUsageIntervals(ctx context.Context) error {
	if err := q.ProductQueries.CloseOrphanedSandboxUsageIntervals(ctx); err != nil {
		return err
	}
	return q.ClusterQueries.CloseOrphanedRepoGatewaySandboxUsageIntervals(ctx)
}
