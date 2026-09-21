package db

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func reserveProvisioningID(t *testing.T, tx DBTX) int64 {
	t.Helper()
	var repositoryID int64
	require.NoError(t, tx.QueryRow(context.Background(),
		`SELECT nextval(pg_get_serial_sequence('repositories', 'id'))`).Scan(&repositoryID))
	return repositoryID
}

func insertUserProvisioningOperation(t *testing.T, tx DBTX, repositoryID, userID int64, owner, name, token string) {
	t.Helper()
	_, err := tx.Exec(context.Background(), `
		INSERT INTO repository_provisioning_operations (
			repository_id, operation_type, token, actor_id, storage_set_id,
			owner_name, user_id, name, lower_name, description,
			is_public, default_bookmark, publish_ready
		) VALUES ($1, 'init', $2, $3, 's1', $4, $3, $5::varchar, LOWER($5::text), '', TRUE, 'main', TRUE)
	`, repositoryID, token, userID, owner, name)
	require.NoError(t, err)
}

func TestRepositoryProvisioningFenceRequiresExactPublishReadyToken(t *testing.T) {
	ctx := context.Background()
	_, tx := newQueries(t)
	owner := uniqueTestUsername(t)
	userID := mustCreateUser(t, tx, owner)
	_, err := tx.Exec(ctx, `SELECT set_config('smithers.test_repository_insert', 'off', TRUE)`)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `UPDATE repository_provisioning_control SET enforce_insert_fence = TRUE WHERE singleton`)
	require.NoError(t, err)

	directErr := mustExpectError(t, tx, func(sp DBTX) error {
		_, insertErr := sp.Exec(ctx, `
			INSERT INTO repositories (user_id, name, lower_name, description, storage_set_id, is_public, default_bookmark)
			VALUES ($1, 'direct', 'direct', '', 's1', TRUE, 'main')
		`, userID)
		return insertErr
	})
	var pgErr *pgconn.PgError
	require.ErrorAs(t, directErr, &pgErr)
	assert.Equal(t, "55006", pgErr.Code)
	assert.Contains(t, pgErr.Message, "authorized published provisioning operation")

	repositoryID := reserveProvisioningID(t, tx)
	token := strings.Repeat("1", 64)
	insertUserProvisioningOperation(t, tx, repositoryID, userID, owner, "exact", token)

	missingTokenErr := mustExpectError(t, tx, func(sp DBTX) error {
		_, insertErr := sp.Exec(ctx, `
			INSERT INTO repositories (id, user_id, name, lower_name, description, storage_set_id, is_public, default_bookmark)
			VALUES ($1, $2, 'exact', 'exact', '', 's1', TRUE, 'main')
		`, repositoryID, userID)
		return insertErr
	})
	require.ErrorAs(t, missingTokenErr, &pgErr)
	assert.Equal(t, "55006", pgErr.Code)

	_, err = tx.Exec(ctx, `SELECT set_config('smithers.repository_provisioning_token', $1, TRUE)`, token)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `
		INSERT INTO repositories (id, user_id, name, lower_name, description, storage_set_id, is_public, default_bookmark)
		VALUES ($1, $2, 'exact', 'exact', '', 's1', TRUE, 'main')
	`, repositoryID, userID)
	require.NoError(t, err)
}

func TestRepositoryProvisioningIntentRejectsUnauthorizedOrgActor(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	actorID := mustCreateUser(t, tx, uniqueTestUsername(t))
	orgName := uniqueTestUsername(t)
	org, err := q.CreateOrganization(ctx, CreateOrganizationParams{
		Name: orgName, LowerName: orgName, Description: "", Visibility: "public",
	})
	require.NoError(t, err)
	repositoryID := reserveProvisioningID(t, tx)

	intentErr := mustExpectError(t, tx, func(sp DBTX) error {
		_, insertErr := sp.Exec(ctx, `
			INSERT INTO repository_provisioning_operations (
				repository_id, operation_type, token, actor_id, storage_set_id,
				owner_name, org_id, name, lower_name, description,
				is_public, default_bookmark
			) VALUES ($1, 'init', $2, $3, 's1', $4, $5, 'private', 'private', '', FALSE, 'main')
		`, repositoryID, strings.Repeat("2", 64), actorID, orgName, org.ID)
		return insertErr
	})
	var pgErr *pgconn.PgError
	require.ErrorAs(t, intentErr, &pgErr)
	assert.Equal(t, "42501", pgErr.Code)
	assert.Contains(t, pgErr.Message, "not an organization owner")
}

func TestRepositoryProvisioningForkRejectsUnauthorizedPrivateOrgSource(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	actorName := uniqueTestUsername(t)
	actorID := mustCreateUser(t, tx, actorName)
	sourceOwnerID := mustCreateUser(t, tx, uniqueTestUsername(t))
	sourceOrgName := uniqueTestUsername(t)
	sourceOrg, err := q.CreateOrganization(ctx, CreateOrganizationParams{
		Name: sourceOrgName, LowerName: sourceOrgName, Description: "", Visibility: "private",
	})
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `
		INSERT INTO org_members (organization_id, user_id, role)
		VALUES ($1, $2, 'owner')
	`, sourceOrg.ID, sourceOwnerID)
	require.NoError(t, err)

	var sourceRepositoryID int64
	err = tx.QueryRow(ctx, `
		INSERT INTO repositories (
			org_id, name, lower_name, description, storage_set_id,
			is_public, default_bookmark
		) VALUES ($1, 'private-source', 'private-source', '', 's1', FALSE, 'main')
		RETURNING id
	`, sourceOrg.ID).Scan(&sourceRepositoryID)
	require.NoError(t, err)

	targetRepositoryID := reserveProvisioningID(t, tx)
	intentErr := mustExpectError(t, tx, func(sp DBTX) error {
		_, insertErr := sp.Exec(ctx, `
			INSERT INTO repository_provisioning_operations (
				repository_id, operation_type, token, actor_id, storage_set_id,
				owner_name, user_id, name, lower_name, description,
				is_public, default_bookmark, is_fork, fork_id,
				source_repository_id, source_owner, source_repo,
				source_storage_set_id
			) VALUES (
				$1, 'fork', $2, $3, 's1', $4, $3,
				'private-copy', 'private-copy', '', FALSE, 'main', TRUE,
				$5, $5, $6, 'private-source', 's1'
			)
		`, targetRepositoryID, strings.Repeat("5", 64), actorID, actorName,
			sourceRepositoryID, sourceOrgName)
		return insertErr
	})
	var pgErr *pgconn.PgError
	require.ErrorAs(t, intentErr, &pgErr)
	assert.Equal(t, "42501", pgErr.Code)
	assert.Contains(t, pgErr.Message, "cannot read fork source")
}

func TestRepositoryProvisioningNamespaceRaceHasSingleWinner(t *testing.T) {
	ctx := context.Background()
	owner := uniqueTestUsername(t)
	userID := mustCreateUser(t, sharedPool, owner)
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM repository_provisioning_operations WHERE user_id = $1`, userID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})

	tx1, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx1.Rollback(context.Background()) })
	tx2, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx2.Rollback(context.Background()) })
	id1 := reserveProvisioningID(t, tx1)
	id2 := reserveProvisioningID(t, tx2)
	insertUserProvisioningOperation(t, tx1, id1, userID, owner, "contended", strings.Repeat("3", 64))

	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		close(started)
		_, insertErr := tx2.Exec(ctx, `
			INSERT INTO repository_provisioning_operations (
				repository_id, operation_type, token, actor_id, storage_set_id,
				owner_name, user_id, name, lower_name, description,
				is_public, default_bookmark
			) VALUES ($1, 'init', $2, $3, 's1', $4, $3, 'contended', 'contended', '', TRUE, 'main')
		`, id2, strings.Repeat("4", 64), userID, owner)
		done <- insertErr
	}()
	<-started
	select {
	case err := <-done:
		t.Fatalf("second namespace claimant did not serialize: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	require.NoError(t, tx1.Commit(ctx))

	select {
	case raceErr := <-done:
		var pgErr *pgconn.PgError
		require.ErrorAs(t, raceErr, &pgErr)
		assert.Equal(t, "23505", pgErr.Code)
	case <-time.After(2 * time.Second):
		t.Fatal("second namespace claimant remained blocked after winner committed")
	}
	require.NoError(t, tx2.Rollback(ctx))
}
