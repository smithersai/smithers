package db

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type sandboxAccessTokensSQLHDB = chunk5SQLHDB
type sandboxAccessTokensSQLHRow = chunk5SQLHRow

func TestSandboxAccessTokensSQL_H_CreateGetMarkAndExpire(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))
	tokenHash := []byte("token-" + randSlug(t))

	token, err := q.CreateSandboxAccessToken(ctx, CreateSandboxAccessTokenParams{
		WorkspaceID: pgtype.UUID{}, VmID: "vm-h", UserID: userID, LinuxUser: "smithers", TokenHash: tokenHash, TokenType: "ssh", ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	assert.Equal(t, tokenHash, token.TokenHash)
	got, err := q.GetSandboxAccessTokenByHash(ctx, tokenHash)
	require.NoError(t, err)
	assert.Equal(t, token.ID, got.ID)
	require.NoError(t, q.MarkSandboxAccessTokenUsed(ctx, token.ID))
	_, err = q.GetSandboxAccessTokenByHash(ctx, tokenHash)
	require.ErrorIs(t, err, pgx.ErrNoRows)

	expiredHash := []byte("expired-" + randSlug(t))
	_, err = q.CreateSandboxAccessToken(ctx, CreateSandboxAccessTokenParams{
		WorkspaceID: pgtype.UUID{}, VmID: "vm-h-exp", UserID: userID, LinuxUser: "smithers", TokenHash: expiredHash, TokenType: "terminal", ExpiresAt: time.Now().Add(-time.Hour),
	})
	require.NoError(t, err)
	require.NoError(t, q.DeleteExpiredSandboxAccessTokens(ctx))
	_, err = q.GetSandboxAccessTokenByHash(ctx, expiredHash)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateSandboxAccessToken(ctx, CreateSandboxAccessTokenParams{
			UserID: userID, VmID: "vm-bad", LinuxUser: "smithers", TokenHash: []byte("bad"), TokenType: "bad", ExpiresAt: time.Now().Add(time.Hour),
		})
		return err
	})
}

func TestSandboxAccessTokensSQL_H_ErrorBranches(t *testing.T) {
	sentinel := errors.New("sandbox access tokens h failed")
	rowQ := New(sandboxAccessTokensSQLHDB{row: sandboxAccessTokensSQLHRow{err: sentinel}})
	_, err := rowQ.CreateSandboxAccessToken(context.Background(), CreateSandboxAccessTokenParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetSandboxAccessTokenByHash(context.Background(), []byte("hash"))
	require.ErrorIs(t, err, sentinel)
	execQ := New(sandboxAccessTokensSQLHDB{execErr: sentinel})
	require.ErrorIs(t, execQ.DeleteExpiredSandboxAccessTokens(context.Background()), sentinel)
	require.ErrorIs(t, execQ.MarkSandboxAccessTokenUsed(context.Background(), "id"), sentinel)
}
