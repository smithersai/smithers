package services

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestBillingService_StorageIncreaseFiniteLimitIsOverflowSafe(t *testing.T) {
	t.Parallel()

	const storageCap = int64(100 * 1024 * 1024 * 1024)
	assert.True(t, storageIncreaseWithinLimit(storageCap, storageCap-1, 1), "the exact finite boundary is allowed")
	assert.False(t, storageIncreaseWithinLimit(storageCap, storageCap-1, 2), "one byte beyond the boundary is denied")
	assert.False(t, storageIncreaseWithinLimit(storageCap, 1, math.MaxInt64), "int64 addition must not wrap into an allow")
	assert.False(t, storageIncreaseWithinLimit(unlimitedBillingQuantity, -1, 1), "anomalous negative usage fails closed even for unlimited plans")

	queries := newBillingQuerierMock()
	queries.sumStorageBytesByOwnerFn = func(context.Context, db.SumStorageBytesByOwnerParams) (int64, error) {
		return storageCap - 1, nil
	}
	svc := NewBillingService(queries, nil, BillingServiceConfig{})
	require.NoError(t, svc.AuthorizeStorageIncrease(context.Background(), 11, 1))
	err := svc.AuthorizeStorageIncrease(context.Background(), 11, math.MaxInt64)
	require.Error(t, err)
	assert.Equal(t, 403, httpStatus(err))

	committed := false
	require.NoError(t, svc.AuthorizeStorageIncreaseCommittedDynamic(
		context.Background(),
		11,
		func(context.Context) (int64, error) { return 1, nil },
		func(context.Context) error { committed = true; return nil },
	))
	assert.True(t, committed)

	committed = false
	err = svc.AuthorizeStorageIncreaseCommittedDynamic(
		context.Background(),
		11,
		func(context.Context) (int64, error) { return math.MaxInt64, nil },
		func(context.Context) error { committed = true; return nil },
	)
	require.Error(t, err)
	assert.Equal(t, 403, httpStatus(err))
	assert.False(t, committed, "overflowing dynamic increases must fail before commit")
}

// billingCommittedTxQuerier wraps billingQuerierMock (which does NOT
// implement BeginTx/WithTx) with just enough of billingTxQuerier to prove
// AuthorizeStorageIncreaseCommitted's transactional branch is selected and
// wired correctly. It short-circuits at BeginTx, so it does not need to fake
// the SQL resolveLocalState would otherwise issue through the returned
// *db.Queries.
type billingCommittedTxQuerier struct {
	*billingQuerierMock
	beginErr error
}

func (q *billingCommittedTxQuerier) BeginTx(context.Context) (pgx.Tx, error) {
	return nil, q.beginErr
}

func (q *billingCommittedTxQuerier) WithTx(pgx.Tx) *db.Queries {
	panic("WithTx must not be reached when BeginTx fails")
}

// TestBillingService_AuthorizeStorageIncreaseCommitted_ZeroOrNegativeBytesSkipsCheck
// covers the fast path: no storage increase means no authorization is
// needed, so commit runs unconditionally (matching AuthorizeStorageIncrease's
// own additionalBytes <= 0 short-circuit).
func TestBillingService_AuthorizeStorageIncreaseCommitted_ZeroOrNegativeBytesSkipsCheck(t *testing.T) {
	t.Parallel()

	svc := NewBillingService(newBillingQuerierMock(), nil, BillingServiceConfig{})
	for _, additional := range []int64{0, -1} {
		committed := false
		err := svc.AuthorizeStorageIncreaseCommitted(context.Background(), 11, additional, func(context.Context) error {
			committed = true
			return nil
		})
		require.NoError(t, err)
		assert.True(t, committed)
	}
}

// TestBillingService_AuthorizeStorageIncreaseCommitted_DegradesWithoutTxQuerier
// covers the fallback path used by unit-test fakes (any BillingQuerier that
// does not also implement BeginTx/WithTx): a plain check-then-commit, with
// the same allow/deny semantics as AuthorizeStorageIncrease.
func TestBillingService_AuthorizeStorageIncreaseCommitted_DegradesWithoutTxQuerier(t *testing.T) {
	t.Parallel()

	// Denied: usage is already at the free plan's 100GB cap.
	deniedQueries := newBillingQuerierMock()
	deniedQueries.sumStorageBytesByOwnerFn = func(context.Context, db.SumStorageBytesByOwnerParams) (int64, error) {
		return 100 * 1024 * 1024 * 1024, nil
	}
	deniedSvc := NewBillingService(deniedQueries, nil, BillingServiceConfig{})
	committed := false
	err := deniedSvc.AuthorizeStorageIncreaseCommitted(context.Background(), 11, 1, func(context.Context) error {
		committed = true
		return nil
	})
	require.Error(t, err)
	assert.Equal(t, 403, httpStatus(err))
	assert.False(t, committed, "commit must not run when the storage cap denies the request")

	// Allowed: plenty of headroom, commit runs and its result propagates.
	allowedQueries := newBillingQuerierMock()
	allowedSvc := NewBillingService(allowedQueries, nil, BillingServiceConfig{})
	committed = false
	err = allowedSvc.AuthorizeStorageIncreaseCommitted(context.Background(), 11, 1, func(context.Context) error {
		committed = true
		return nil
	})
	require.NoError(t, err)
	assert.True(t, committed)

	// Allowed but commit itself fails: the failure propagates untouched.
	committed = false
	commitErr := errors.New("finalizing write failed")
	err = allowedSvc.AuthorizeStorageIncreaseCommitted(context.Background(), 11, 1, func(context.Context) error {
		committed = true
		return commitErr
	})
	require.ErrorIs(t, err, commitErr)
	assert.True(t, committed)
}

// TestBillingService_AuthorizeStorageIncreaseCommitted_TxQuerierBeginTxError
// proves the transactional branch is actually selected (via the
// s.queries.(billingTxQuerier) type assertion) when the configured querier
// implements BeginTx/WithTx, and that a failure to begin the lock
// transaction surfaces as an Internal error without ever invoking commit.
func TestBillingService_AuthorizeStorageIncreaseCommitted_TxQuerierBeginTxError(t *testing.T) {
	t.Parallel()

	q := &billingCommittedTxQuerier{billingQuerierMock: newBillingQuerierMock(), beginErr: errors.New("connection pool exhausted")}
	svc := NewBillingService(q, nil, BillingServiceConfig{})

	committed := false
	err := svc.AuthorizeStorageIncreaseCommitted(context.Background(), 11, 1, func(context.Context) error {
		committed = true
		return nil
	})
	require.Error(t, err)
	assert.Equal(t, 500, httpStatus(err))
	assert.False(t, committed)
}
