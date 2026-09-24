package db

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"
)

// The secret service's count check is a friendly pre-check; these triggers
// enforce the 100-secret caps atomically so concurrent writers cannot race
// past it. Updating an existing name at the cap stays allowed.

func requireCapViolation(t *testing.T, err error, constraint string) {
	t.Helper()
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	require.Equal(t, "23514", pgErr.Code)
	require.Equal(t, constraint, pgErr.ConstraintName)
}

func TestRepositorySecretCapTrigger_RejectsTheHundredAndFirstName(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))
	repoID := mustCreateRepo(t, pool, userID, uniqueTestRepoName(t))

	for i := range 100 {
		_, err := q.CreateOrUpdateSecret(ctx, CreateOrUpdateSecretParams{RepositoryID: repoID, Name: fmt.Sprintf("S%d", i), ValueEncrypted: []byte("v")})
		require.NoError(t, err, "secret %d of 100 must be allowed", i+1)
	}
	_, err := q.CreateOrUpdateSecret(ctx, CreateOrUpdateSecretParams{RepositoryID: repoID, Name: "S0", ValueEncrypted: []byte("v2")})
	require.NoError(t, err, "updating an existing secret at the cap is allowed")

	_, err = q.CreateOrUpdateSecret(ctx, CreateOrUpdateSecretParams{RepositoryID: repoID, Name: "S100", ValueEncrypted: []byte("v")})
	requireCapViolation(t, err, "repository_secrets_repo_cap")
}

func TestOrganizationSecretCapTrigger_RejectsTheHundredAndFirstName(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	orgID := mustCreateOrganization(t, pool, uniqueTestUsername(t))

	for i := range 100 {
		_, err := q.CreateOrUpdateOrgSecret(ctx, CreateOrUpdateOrgSecretParams{OrganizationID: orgID, Name: fmt.Sprintf("S%d", i), ValueEncrypted: []byte("v")})
		require.NoError(t, err, "secret %d of 100 must be allowed", i+1)
	}
	_, err := q.CreateOrUpdateOrgSecret(ctx, CreateOrUpdateOrgSecretParams{OrganizationID: orgID, Name: "S0", ValueEncrypted: []byte("v2")})
	require.NoError(t, err, "updating an existing secret at the cap is allowed")

	_, err = q.CreateOrUpdateOrgSecret(ctx, CreateOrUpdateOrgSecretParams{OrganizationID: orgID, Name: "S100", ValueEncrypted: []byte("v")})
	requireCapViolation(t, err, "organization_secrets_org_cap")
}
