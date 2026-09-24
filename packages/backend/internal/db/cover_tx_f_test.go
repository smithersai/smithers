package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFCov_WithTx_ReturnsQueriesBoundToTx(t *testing.T) {
	q, pool := newQueries(t)
	tx, ok := pool.(pgx.Tx)
	require.True(t, ok)
	bound := q.WithTx(tx)
	require.NotNil(t, bound)
}

func TestFCov_BeginTx_SupportedAndUnsupported(t *testing.T) {
	ctx := context.Background()

	// Supported: the shared-pool transaction handle can begin a nested tx.
	q, _ := newQueries(t)
	nested, err := q.BeginTx(ctx)
	require.NoError(t, err)
	require.NoError(t, nested.Rollback(ctx))

	// Unsupported: a DBTX without Begin returns an error.
	_, err = New(fcovDB{}).BeginTx(ctx)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "transactions unsupported")
}
