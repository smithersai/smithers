package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNotification_Z_BeginCreateTxBeginError(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	pool, err := pgxpool.New(context.Background(), "postgres://127.0.0.1:1/nope?sslmode=disable")
	require.NoError(t, err)
	defer pool.Close()

	tx, err := (&pgxNotificationCreateTxManager{pool: pool}).BeginCreateTx(ctx)
	require.Error(t, err)
	assert.Nil(t, tx)
}
