// Package identity contains product-neutral identity boundaries shared by
// HTTP, Git, SSE, and SSH transports.
package identity

import (
	"context"
	"errors"
	"sync/atomic"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// OwnerQuerier resolves the immutable owner of a single-owner installation.
type OwnerQuerier interface {
	GetSelfHostOwner(context.Context) (db.User, error)
}

// OwnerAuthorizer is the common identity check used by every authenticated
// transport. Resource-scoped credentials such as deploy keys are checked by
// their own owner-authorized minting paths and do not implement this interface.
type OwnerAuthorizer interface {
	AuthorizeOwner(context.Context, int64) *pkgerrors.APIError
}

// SingleOwnerBoundary authorizes exactly the persisted installation owner.
// A successful lookup is cached: the singleton row cannot be reassigned, while
// an uninitialized installation remains observable until bootstrap succeeds.
type SingleOwnerBoundary struct {
	queries OwnerQuerier
	ownerID atomic.Int64
}

func NewSingleOwnerBoundary(queries OwnerQuerier) *SingleOwnerBoundary {
	return &SingleOwnerBoundary{queries: queries}
}

func (b *SingleOwnerBoundary) AuthorizeOwner(ctx context.Context, userID int64) *pkgerrors.APIError {
	if b == nil || b.queries == nil {
		return pkgerrors.Internal("single-owner authorization is not configured")
	}
	ownerID := b.ownerID.Load()
	if ownerID == 0 {
		owner, err := b.queries.GetSelfHostOwner(ctx)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return pkgerrors.Unauthorized("installation owner is not initialized")
			}
			return pkgerrors.Internal("failed to authorize installation owner").WithCause(err)
		}
		ownerID = owner.ID
		if ownerID <= 0 {
			return pkgerrors.Internal("installation owner is invalid")
		}
		b.ownerID.CompareAndSwap(0, ownerID)
		ownerID = b.ownerID.Load()
	}
	if ownerID != userID {
		return pkgerrors.Forbidden("credential does not belong to the installation owner")
	}
	return nil
}
