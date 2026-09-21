package db

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type deployKeysSQLHDB = chunk4SQLHDB
type deployKeysSQLHRow = chunk4SQLHRow
type deployKeysSQLHRows = chunk4SQLHRows

func TestDeployKeysSQL_H_RoundTripTouchAndDelete(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	fingerprint := "SHA256:" + randSlug(t)

	key, err := q.CreateDeployKey(ctx, CreateDeployKeyParams{
		RepositoryID:   repoID,
		Title:          "deploy key",
		KeyFingerprint: fingerprint,
		PublicKey:      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + randSlug(t),
		ReadOnly:       true,
	})
	require.NoError(t, err)
	assert.Equal(t, fingerprint, key.KeyFingerprint)

	byID, err := q.GetDeployKeyByID(ctx, key.ID)
	require.NoError(t, err)
	assert.Equal(t, key.ID, byID.ID)
	byFingerprint, err := q.GetDeployKeyByFingerprint(ctx, GetDeployKeyByFingerprintParams{RepositoryID: repoID, KeyFingerprint: fingerprint})
	require.NoError(t, err)
	assert.Equal(t, key.ID, byFingerprint.ID)
	anyByFingerprint, err := q.GetAnyDeployKeyByFingerprint(ctx, fingerprint)
	require.NoError(t, err)
	assert.Equal(t, key.ID, anyByFingerprint.ID)
	keys, err := q.ListDeployKeysByRepo(ctx, repoID)
	require.NoError(t, err)
	require.Len(t, keys, 1)
	assert.Equal(t, key.ID, keys[0].ID)

	require.NoError(t, q.TouchDeployKeyLastUsed(ctx, key.ID))
	touched, err := q.GetDeployKeyByID(ctx, key.ID)
	require.NoError(t, err)
	assert.True(t, touched.LastUsedAt.Valid)
	require.NoError(t, q.DeleteDeployKey(ctx, key.ID))
	_, err = q.GetDeployKeyByID(ctx, key.ID)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetDeployKeyByFingerprint(ctx, GetDeployKeyByFingerprintParams{RepositoryID: repoID, KeyFingerprint: fingerprint})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetAnyDeployKeyByFingerprint(ctx, fingerprint)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	keys, err = q.ListDeployKeysByRepo(ctx, repoID)
	require.NoError(t, err)
	assert.Empty(t, keys)

	dup, err := q.CreateDeployKey(ctx, CreateDeployKeyParams{RepositoryID: repoID, Title: "dup", KeyFingerprint: "SHA256:" + randSlug(t), PublicKey: "ssh-rsa AAAA", ReadOnly: false})
	require.NoError(t, err)
	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateDeployKey(ctx, CreateDeployKeyParams{
			RepositoryID: repoID, Title: "dup2", KeyFingerprint: dup.KeyFingerprint, PublicKey: "ssh-rsa BBBB", ReadOnly: false,
		})
		return err
	})
}

func TestDeployKeysSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("deploy keys h rows failed")
	call := func(q *Queries) error {
		_, err := q.ListDeployKeysByRepo(context.Background(), 1)
		return err
	}
	require.ErrorIs(t, call(New(deployKeysSQLHDB{queryErr: sentinel})), sentinel)
	require.ErrorIs(t, call(New(deployKeysSQLHDB{rows: &deployKeysSQLHRows{next: true, scanErr: sentinel}})), sentinel)
	require.ErrorIs(t, call(New(deployKeysSQLHDB{rows: &deployKeysSQLHRows{err: sentinel}})), sentinel)
}

func TestDeployKeysSQL_H_QueryRowAndExecErrorBranches(t *testing.T) {
	sentinel := errors.New("deploy keys h failed")
	rowQ := New(deployKeysSQLHDB{row: deployKeysSQLHRow{err: sentinel}})
	_, err := rowQ.CreateDeployKey(context.Background(), CreateDeployKeyParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetAnyDeployKeyByFingerprint(context.Background(), "fp")
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetDeployKeyByFingerprint(context.Background(), GetDeployKeyByFingerprintParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetDeployKeyByID(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)

	execQ := New(deployKeysSQLHDB{execErr: sentinel})
	require.ErrorIs(t, execQ.DeleteDeployKey(context.Background(), 1), sentinel)
	require.ErrorIs(t, execQ.TouchDeployKeyLastUsed(context.Background(), 1), sentinel)
}
