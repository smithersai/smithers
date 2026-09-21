package db

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type linearOAuthSetupsSQLHDB = chunk5SQLHDB
type linearOAuthSetupsSQLHRow = chunk5SQLHRow

func TestLinearOAuthSetupsSQL_H_CreateGetConsumeAndDelete(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))
	setupKey := "lin-" + randSlug(t)

	created, err := q.CreateLinearOAuthSetup(ctx, CreateLinearOAuthSetupParams{
		SetupKey: setupKey, UserID: userID, PayloadEncrypted: []byte("cipher"), ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	assert.Equal(t, setupKey, created.SetupKey)
	got, err := q.GetLinearOAuthSetupByUser(ctx, GetLinearOAuthSetupByUserParams{SetupKey: setupKey, UserID: userID})
	require.NoError(t, err)
	assert.Equal(t, []byte("cipher"), got.PayloadEncrypted)
	consumed, err := q.ConsumeLinearOAuthSetupByUser(ctx, ConsumeLinearOAuthSetupByUserParams{SetupKey: setupKey, UserID: userID})
	require.NoError(t, err)
	assert.Equal(t, setupKey, consumed.SetupKey)
	_, err = q.GetLinearOAuthSetupByUser(ctx, GetLinearOAuthSetupByUserParams{SetupKey: setupKey, UserID: userID})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.ConsumeLinearOAuthSetupByUser(ctx, ConsumeLinearOAuthSetupByUserParams{SetupKey: setupKey, UserID: userID})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	expiredKey := "lin-exp-" + randSlug(t)
	_, err = q.CreateLinearOAuthSetup(ctx, CreateLinearOAuthSetupParams{
		SetupKey: expiredKey, UserID: userID, PayloadEncrypted: []byte("expired"), ExpiresAt: time.Now().Add(-time.Hour),
	})
	require.NoError(t, err)
	require.NoError(t, q.DeleteExpiredLinearOAuthSetups(ctx))
	_, err = q.GetLinearOAuthSetupByUser(ctx, GetLinearOAuthSetupByUserParams{SetupKey: expiredKey, UserID: userID})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	deleteKey := "lin-del-" + randSlug(t)
	_, err = q.CreateLinearOAuthSetup(ctx, CreateLinearOAuthSetupParams{
		SetupKey: deleteKey, UserID: userID, PayloadEncrypted: []byte("delete"), ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	require.NoError(t, q.DeleteLinearOAuthSetupsByUser(ctx, userID))
	_, err = q.GetLinearOAuthSetupByUser(ctx, GetLinearOAuthSetupByUserParams{SetupKey: deleteKey, UserID: userID})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateLinearOAuthSetup(ctx, CreateLinearOAuthSetupParams{
			SetupKey: "lin-bad-" + randSlug(t), UserID: 999999999, PayloadEncrypted: []byte("bad"), ExpiresAt: time.Now().Add(time.Hour),
		})
		return err
	})
}

func TestLinearOAuthSetupsSQL_H_ErrorBranches(t *testing.T) {
	sentinel := errors.New("linear oauth setups h failed")
	rowQ := New(linearOAuthSetupsSQLHDB{row: linearOAuthSetupsSQLHRow{err: sentinel}})
	_, err := rowQ.ConsumeLinearOAuthSetupByUser(context.Background(), ConsumeLinearOAuthSetupByUserParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.CreateLinearOAuthSetup(context.Background(), CreateLinearOAuthSetupParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetLinearOAuthSetupByUser(context.Background(), GetLinearOAuthSetupByUserParams{})
	require.ErrorIs(t, err, sentinel)

	execQ := New(linearOAuthSetupsSQLHDB{execErr: sentinel})
	require.ErrorIs(t, execQ.DeleteExpiredLinearOAuthSetups(context.Background()), sentinel)
	require.ErrorIs(t, execQ.DeleteLinearOAuthSetupsByUser(context.Background(), 1), sentinel)
}
