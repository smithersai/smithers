package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSSHKeyCRUDQueries(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "ssh-key-user")

	created, err := q.CreateSSHKey(context.Background(), CreateSSHKeyParams{
		UserID:      userID,
		Name:        "laptop",
		PublicKey:   "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAexample test@example.com",
		Fingerprint: "SHA256:abcdefgh12345678",
		KeyType:     "user",
	})
	require.NoError(t, err)
	assert.Equal(t, userID, created.UserID)

	keys, err := q.ListUserSSHKeys(context.Background(), userID)
	require.NoError(t, err)
	require.Len(t, keys, 1)
	assert.Equal(t, created.ID, keys[0].ID)

	keyByID, err := q.GetSSHKeyByID(context.Background(), created.ID)
	require.NoError(t, err)
	assert.Equal(t, created.Fingerprint, keyByID.Fingerprint)

	keyByFingerprint, err := q.GetSSHKeyByFingerprint(context.Background(), created.Fingerprint)
	require.NoError(t, err)
	assert.Equal(t, created.ID, keyByFingerprint.ID)

	err = q.DeleteSSHKey(context.Background(), DeleteSSHKeyParams{
		ID:     created.ID,
		UserID: userID,
	})
	require.NoError(t, err)

	_, err = q.GetSSHKeyByID(context.Background(), created.ID)
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestGetUserBySSHFingerprint(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "ssh-fingerprint-user")

	_, err := q.CreateSSHKey(context.Background(), CreateSSHKeyParams{
		UserID:      userID,
		Name:        "lookup-key",
		PublicKey:   "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBexample lookup@example.com",
		Fingerprint: "SHA256:lookupfingerprint123",
		KeyType:     "user",
	})
	require.NoError(t, err)

	// Active user is returned by fingerprint lookup.
	row, err := q.GetUserBySSHFingerprint(context.Background(), "SHA256:lookupfingerprint123")
	require.NoError(t, err)
	assert.Equal(t, userID, row.UserID)
	assert.Equal(t, "ssh-fingerprint-user", row.Username)

	// Non-existent fingerprint returns ErrNoRows.
	_, err = q.GetUserBySSHFingerprint(context.Background(), "SHA256:doesnotexist")
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)

	// Deactivated user is not returned.
	mustExec(t, pool, `UPDATE users SET is_active = false WHERE id = $1`, userID)
	_, err = q.GetUserBySSHFingerprint(context.Background(), "SHA256:lookupfingerprint123")
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestGetUserBySSHFingerprint_ProhibitedLoginUserReturnsNoRows(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "ssh-prohibit-login-user")

	_, err := q.CreateSSHKey(context.Background(), CreateSSHKeyParams{
		UserID:      userID,
		Name:        "prohibited-key",
		PublicKey:   "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICexample prohibited@example.com",
		Fingerprint: "SHA256:prohibitedfingerprint456",
		KeyType:     "user",
	})
	require.NoError(t, err)

	// Confirmed active user with key is found.
	row, err := q.GetUserBySSHFingerprint(context.Background(), "SHA256:prohibitedfingerprint456")
	require.NoError(t, err)
	assert.Equal(t, userID, row.UserID)

	// Set prohibit_login = true — user should no longer be returned.
	mustExec(t, pool, `UPDATE users SET prohibit_login = true WHERE id = $1`, userID)
	_, err = q.GetUserBySSHFingerprint(context.Background(), "SHA256:prohibitedfingerprint456")
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows, "prohibited-login user should not be returned by SSH fingerprint lookup")
}
