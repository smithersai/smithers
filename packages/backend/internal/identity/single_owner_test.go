package identity

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type ownerQueries struct {
	owner db.User
	err   error
	calls int
}

func (q *ownerQueries) GetSelfHostOwner(context.Context) (db.User, error) {
	q.calls++
	return q.owner, q.err
}

func TestSingleOwnerBoundaryCachesOwnerAndRejectsForeignPrincipal(t *testing.T) {
	q := &ownerQueries{owner: db.User{ID: 7}}
	boundary := NewSingleOwnerBoundary(q)
	require.Nil(t, boundary.AuthorizeOwner(context.Background(), 7))
	require.Nil(t, boundary.AuthorizeOwner(context.Background(), 7))
	assert.Equal(t, 1, q.calls)

	err := boundary.AuthorizeOwner(context.Background(), 8)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "installation owner")
}

func TestSingleOwnerBoundaryDoesNotCacheUninitializedState(t *testing.T) {
	q := &ownerQueries{err: pgx.ErrNoRows}
	boundary := NewSingleOwnerBoundary(q)
	require.NotNil(t, boundary.AuthorizeOwner(context.Background(), 7))

	q.err = nil
	q.owner = db.User{ID: 7}
	require.Nil(t, boundary.AuthorizeOwner(context.Background(), 7))
	assert.Equal(t, 2, q.calls)
}
