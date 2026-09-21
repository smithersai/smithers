package db

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSecretsSQL_H_RepositoryAndOrganizationSecretsRoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	orgID := secretsSQLHCreateOrg(t, pool, "org-"+randSlug(t))

	secret, err := q.CreateOrUpdateSecret(ctx, CreateOrUpdateSecretParams{
		RepositoryID:   repoID,
		Name:           "API_KEY",
		ValueEncrypted: []byte("cipher-one"),
	})
	require.NoError(t, err)
	assert.Equal(t, []byte("cipher-one"), secret.ValueEncrypted)
	secret, err = q.CreateOrUpdateSecret(ctx, CreateOrUpdateSecretParams{
		RepositoryID:   repoID,
		Name:           "API_KEY",
		ValueEncrypted: []byte("cipher-two"),
	})
	require.NoError(t, err)
	assert.Equal(t, []byte("cipher-two"), secret.ValueEncrypted)

	value, err := q.GetSecretValueByName(ctx, GetSecretValueByNameParams{RepositoryID: repoID, Name: "API_KEY"})
	require.NoError(t, err)
	assert.Equal(t, []byte("cipher-two"), value)

	_, err = q.CreateOrUpdateSecret(ctx, CreateOrUpdateSecretParams{
		RepositoryID:   repoID,
		Name:           "TOKEN",
		ValueEncrypted: []byte("cipher-token"),
	})
	require.NoError(t, err)
	secrets, err := q.ListSecrets(ctx, repoID)
	require.NoError(t, err)
	require.Len(t, secrets, 2)
	assert.Equal(t, "API_KEY", secrets[0].Name)
	values, err := q.ListSecretValues(ctx, repoID)
	require.NoError(t, err)
	require.Len(t, values, 2)
	assert.Equal(t, []byte("cipher-two"), values[0].ValueEncrypted)
	valuesForRepo, err := q.ListSecretValuesForRepo(ctx, repoID)
	require.NoError(t, err)
	require.Len(t, valuesForRepo, 2)

	require.NoError(t, q.DeleteSecret(ctx, DeleteSecretParams{RepositoryID: repoID, Name: "API_KEY"}))
	_, err = q.GetSecretValueByName(ctx, GetSecretValueByNameParams{RepositoryID: repoID, Name: "API_KEY"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	require.NoError(t, q.DeleteSecret(ctx, DeleteSecretParams{RepositoryID: repoID, Name: "API_KEY"}))

	orgSecret, err := q.CreateOrUpdateOrgSecret(ctx, CreateOrUpdateOrgSecretParams{
		OrganizationID: orgID,
		Name:           "ORG_KEY",
		ValueEncrypted: []byte("org-one"),
	})
	require.NoError(t, err)
	assert.Equal(t, []byte("org-one"), orgSecret.ValueEncrypted)
	orgSecret, err = q.CreateOrUpdateOrgSecret(ctx, CreateOrUpdateOrgSecretParams{
		OrganizationID: orgID,
		Name:           "ORG_KEY",
		ValueEncrypted: []byte("org-two"),
	})
	require.NoError(t, err)
	assert.Equal(t, []byte("org-two"), orgSecret.ValueEncrypted)
	_, err = q.CreateOrUpdateOrgSecret(ctx, CreateOrUpdateOrgSecretParams{
		OrganizationID: orgID,
		Name:           "ORG_TOKEN",
		ValueEncrypted: []byte("org-token"),
	})
	require.NoError(t, err)

	orgSecrets, err := q.ListOrgSecrets(ctx, orgID)
	require.NoError(t, err)
	require.Len(t, orgSecrets, 2)
	orgValues, err := q.ListOrgSecretValues(ctx, orgID)
	require.NoError(t, err)
	require.Len(t, orgValues, 2)
	require.NoError(t, q.DeleteOrgSecret(ctx, DeleteOrgSecretParams{OrganizationID: orgID, Name: "ORG_KEY"}))
	require.NoError(t, q.DeleteOrgSecret(ctx, DeleteOrgSecretParams{OrganizationID: orgID, Name: "ORG_KEY"}))

	emptyRepoValues, err := q.ListSecretValues(ctx, 999999)
	require.NoError(t, err)
	assert.Empty(t, emptyRepoValues)
	emptyOrgValues, err := q.ListOrgSecretValues(ctx, 999999)
	require.NoError(t, err)
	assert.Empty(t, emptyOrgValues)

	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateOrUpdateSecret(ctx, CreateOrUpdateSecretParams{
			RepositoryID:   999999,
			Name:           "BAD",
			ValueEncrypted: []byte("bad"),
		})
		return err
	})
	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateOrUpdateOrgSecret(ctx, CreateOrUpdateOrgSecretParams{
			OrganizationID: 999999,
			Name:           "BAD",
			ValueEncrypted: []byte("bad"),
		})
		return err
	})
}

func TestSecretsSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("secrets h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListOrgSecretValues", func(q *Queries) error { _, err := q.ListOrgSecretValues(context.Background(), 1); return err }},
		{"ListOrgSecrets", func(q *Queries) error { _, err := q.ListOrgSecrets(context.Background(), 1); return err }},
		{"ListSecretValues", func(q *Queries) error { _, err := q.ListSecretValues(context.Background(), 1); return err }},
		{"ListSecretValuesForRepo", func(q *Queries) error { _, err := q.ListSecretValuesForRepo(context.Background(), 1); return err }},
		{"ListSecrets", func(q *Queries) error { _, err := q.ListSecrets(context.Background(), 1); return err }},
	}

	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			err := tc.call(New(secretsSQLHDB{queryErr: sentinel}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			err := tc.call(New(secretsSQLHDB{rows: &secretsSQLHRows{next: true, scanErr: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			err := tc.call(New(secretsSQLHDB{rows: &secretsSQLHRows{err: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
	}
}

func TestSecretsSQL_H_QueryRowErrorBranches(t *testing.T) {
	sentinel := errors.New("secrets h row failed")
	q := New(secretsSQLHDB{row: secretsSQLHRow{err: sentinel}})

	_, err := q.CreateOrUpdateOrgSecret(context.Background(), CreateOrUpdateOrgSecretParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.CreateOrUpdateSecret(context.Background(), CreateOrUpdateSecretParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.GetSecretValueByName(context.Background(), GetSecretValueByNameParams{})
	require.ErrorIs(t, err, sentinel)
}

func TestSecretsSQL_H_ExecErrorBranches(t *testing.T) {
	sentinel := errors.New("secrets h exec failed")
	q := New(secretsSQLHDB{execErr: sentinel})

	require.ErrorIs(t, q.DeleteOrgSecret(context.Background(), DeleteOrgSecretParams{}), sentinel)
	require.ErrorIs(t, q.DeleteSecret(context.Background(), DeleteSecretParams{}), sentinel)
}

func secretsSQLHCreateOrg(t *testing.T, pool DBTX, name string) int64 {
	t.Helper()
	lowerName := strings.ToLower(name)
	var id int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO organizations (name, lower_name, description) VALUES ($1, $2, '') RETURNING id`,
		name,
		lowerName,
	).Scan(&id)
	require.NoError(t, err)
	return id
}

type secretsSQLHDB struct {
	execErr  error
	queryErr error
	rows     pgx.Rows
	row      pgx.Row
}

func (db secretsSQLHDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, db.execErr
}

func (db secretsSQLHDB) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	if db.queryErr != nil {
		return nil, db.queryErr
	}
	if db.rows != nil {
		return db.rows, nil
	}
	return &secretsSQLHRows{}, nil
}

func (db secretsSQLHDB) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	if db.row != nil {
		return db.row
	}
	return secretsSQLHRow{err: errors.New("secrets h row failed")}
}

type secretsSQLHRow struct {
	err error
}

func (r secretsSQLHRow) Scan(...any) error {
	return r.err
}

type secretsSQLHRows struct {
	next    bool
	scanErr error
	err     error
}

func (r *secretsSQLHRows) Close() {}

func (r *secretsSQLHRows) Err() error {
	return r.err
}

func (r *secretsSQLHRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r *secretsSQLHRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}

func (r *secretsSQLHRows) Next() bool {
	if r.next {
		r.next = false
		return true
	}
	return false
}

func (r *secretsSQLHRows) Scan(...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	return errors.New("secrets h scan unexpectedly succeeded")
}

func (r *secretsSQLHRows) Values() ([]any, error) {
	return nil, r.err
}

func (r *secretsSQLHRows) RawValues() [][]byte {
	return nil
}

func (r *secretsSQLHRows) Conn() *pgx.Conn {
	return nil
}
