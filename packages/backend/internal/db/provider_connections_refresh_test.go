package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"
)

func TestProviderConnectionRefresh_RecoveryAndRevocation(t *testing.T) {
	q, tx := newQueries(t)
	ctx := context.Background()
	userID := mustCreateUser(t, tx, uniqueTestUsername(t))
	connection, err := q.CreateProviderConnection(ctx, CreateProviderConnectionParams{
		OwnerType: "user", UserID: pgtype.Int8{Int64: userID, Valid: true},
		Provider: "codex", Kind: "oauth", AccessTokenEncrypted: []byte("old"), RefreshTokenEncrypted: []byte("refresh"),
	})
	require.NoError(t, err)
	require.NoError(t, q.MarkProviderConnectionRefreshFailure(ctx, MarkProviderConnectionRefreshFailureParams{
		ID: connection.ID, State: "refresh_failed", RefreshFailures: 5, LastError: "temporary failure",
	}))
	require.NoError(t, q.UpdateProviderConnectionTokens(ctx, UpdateProviderConnectionTokensParams{
		ID: connection.ID, AccessTokenEncrypted: []byte("fresh"), RefreshTokenEncrypted: []byte("rotated"),
	}))
	row, err := q.GetProviderConnection(ctx, connection.ID)
	require.NoError(t, err)
	require.Equal(t, "active", row.State)
	require.Equal(t, []byte("fresh"), row.AccessTokenEncrypted)
	require.Zero(t, row.RefreshFailures)

	_, err = q.RevokeProviderConnection(ctx, RevokeProviderConnectionParams{ID: connection.ID, LastError: "revoked by owner"})
	require.NoError(t, err)
	require.NoError(t, q.UpdateProviderConnectionTokens(ctx, UpdateProviderConnectionTokensParams{
		ID: connection.ID, AccessTokenEncrypted: []byte("late-success"),
	}))
	require.NoError(t, q.MarkProviderConnectionRefreshFailure(ctx, MarkProviderConnectionRefreshFailureParams{
		ID: connection.ID, State: "active", RefreshFailures: 1, LastError: "late failure",
	}))
	row, err = q.GetProviderConnection(ctx, connection.ID)
	require.NoError(t, err)
	require.Equal(t, "revoked", row.State)
	require.Equal(t, []byte("fresh"), row.AccessTokenEncrypted)
	require.Equal(t, "revoked by owner", row.LastError)
}
