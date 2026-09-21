package db

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type variablesSQLHDB = chunk4SQLHDB
type variablesSQLHRow = chunk4SQLHRow
type variablesSQLHRows = chunk4SQLHRows

func TestVariablesSQL_H_RepositoryAndOrgVariables(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	orgID := mustCreateOrganization(t, pool, "var-org-"+randSlug(t))

	repoVar, err := q.CreateOrUpdateVariable(ctx, CreateOrUpdateVariableParams{RepositoryID: repoID, Name: "APP_ENV", Value: "dev"})
	require.NoError(t, err)
	assert.Equal(t, "dev", repoVar.Value)
	repoVar, err = q.CreateOrUpdateVariable(ctx, CreateOrUpdateVariableParams{RepositoryID: repoID, Name: "APP_ENV", Value: "prod"})
	require.NoError(t, err)
	assert.Equal(t, "prod", repoVar.Value)
	gotRepoVar, err := q.GetVariableByName(ctx, GetVariableByNameParams{RepositoryID: repoID, Name: "APP_ENV"})
	require.NoError(t, err)
	assert.Equal(t, repoVar.ID, gotRepoVar.ID)
	repoVars, err := q.ListVariables(ctx, repoID)
	require.NoError(t, err)
	require.Len(t, repoVars, 1)
	require.NoError(t, q.DeleteVariable(ctx, DeleteVariableParams{RepositoryID: repoID, Name: "APP_ENV"}))
	_, err = q.GetVariableByName(ctx, GetVariableByNameParams{RepositoryID: repoID, Name: "APP_ENV"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	require.NoError(t, q.DeleteVariable(ctx, DeleteVariableParams{RepositoryID: repoID, Name: "APP_ENV"}))
	repoVars, err = q.ListVariables(ctx, repoID)
	require.NoError(t, err)
	assert.Empty(t, repoVars)

	orgVar, err := q.CreateOrUpdateOrgVariable(ctx, CreateOrUpdateOrgVariableParams{OrganizationID: orgID, Name: "ORG_ENV", Value: "one"})
	require.NoError(t, err)
	orgVar, err = q.CreateOrUpdateOrgVariable(ctx, CreateOrUpdateOrgVariableParams{OrganizationID: orgID, Name: "ORG_ENV", Value: "two"})
	require.NoError(t, err)
	assert.Equal(t, "two", orgVar.Value)
	gotOrgVar, err := q.GetOrgVariableByName(ctx, GetOrgVariableByNameParams{OrganizationID: orgID, Name: "ORG_ENV"})
	require.NoError(t, err)
	assert.Equal(t, orgVar.ID, gotOrgVar.ID)
	orgVars, err := q.ListOrgVariables(ctx, orgID)
	require.NoError(t, err)
	require.Len(t, orgVars, 1)
	require.NoError(t, q.DeleteOrgVariable(ctx, DeleteOrgVariableParams{OrganizationID: orgID, Name: "ORG_ENV"}))
	_, err = q.GetOrgVariableByName(ctx, GetOrgVariableByNameParams{OrganizationID: orgID, Name: "ORG_ENV"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	orgVars, err = q.ListOrgVariables(ctx, orgID)
	require.NoError(t, err)
	assert.Empty(t, orgVars)

	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateOrUpdateVariable(ctx, CreateOrUpdateVariableParams{RepositoryID: 999999, Name: "BAD", Value: "bad"})
		return err
	})
	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateOrUpdateOrgVariable(ctx, CreateOrUpdateOrgVariableParams{OrganizationID: 999999, Name: "BAD", Value: "bad"})
		return err
	})
}

func TestVariablesSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("variables h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListOrgVariables", func(q *Queries) error { _, err := q.ListOrgVariables(context.Background(), 1); return err }},
		{"ListVariables", func(q *Queries) error { _, err := q.ListVariables(context.Background(), 1); return err }},
	}
	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(variablesSQLHDB{queryErr: sentinel})), sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(variablesSQLHDB{rows: &variablesSQLHRows{next: true, scanErr: sentinel}})), sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(variablesSQLHDB{rows: &variablesSQLHRows{err: sentinel}})), sentinel)
		})
	}
}

func TestVariablesSQL_H_QueryRowAndExecErrorBranches(t *testing.T) {
	sentinel := errors.New("variables h failed")
	rowQ := New(variablesSQLHDB{row: variablesSQLHRow{err: sentinel}})
	_, err := rowQ.CreateOrUpdateOrgVariable(context.Background(), CreateOrUpdateOrgVariableParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.CreateOrUpdateVariable(context.Background(), CreateOrUpdateVariableParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetOrgVariableByName(context.Background(), GetOrgVariableByNameParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetVariableByName(context.Background(), GetVariableByNameParams{})
	require.ErrorIs(t, err, sentinel)

	execQ := New(variablesSQLHDB{execErr: sentinel})
	require.ErrorIs(t, execQ.DeleteOrgVariable(context.Background(), DeleteOrgVariableParams{}), sentinel)
	require.ErrorIs(t, execQ.DeleteVariable(context.Background(), DeleteVariableParams{}), sentinel)
}
