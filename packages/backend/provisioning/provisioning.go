// Package provisioning exports the canonical repository journal contract and
// product operations used by a deployment's placement adapter.
package provisioning

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type Operation = services.RepositoryProvisioningOperation
type Store = services.RepositoryProvisioningStore
type Repository = db.Repository
type Product = services.RepositoryProvisioningProduct

func NewTransaction(tx pgx.Tx) *Product { return services.NewRepositoryProvisioningProduct(tx) }
func RepositoryByID(ctx context.Context, conn db.DBTX, id int64) (Repository, error) {
	return db.New(conn).GetRepoByID(ctx, id)
}

var ErrConflict = services.ErrRepositoryProvisionConflict
var ErrMismatch = services.ErrRepositoryProvisionMismatch
var ErrMissing = services.ErrRepositoryProvisionMissing
var ErrInProgress = services.ErrRepositoryProvisionInProgress

func Same(a, b Operation) bool { return services.SameRepositoryProvision(a, b) }
func MatchesRepository(r Repository, op Operation) bool {
	return services.RepositoryMatchesProvision(r, op)
}
