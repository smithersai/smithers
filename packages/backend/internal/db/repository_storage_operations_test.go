package db

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRepositoryStorageOperationRejectsMalformedMoveTarget(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	ownerID := mustCreateUser(t, pool, uniqueTestUsername(t))
	targetID := mustCreateUser(t, pool, uniqueTestUsername(t))
	repoID := mustCreateRepo(t, pool, ownerID, "malformed-storage-move")

	err := mustExpectError(t, pool, func(sp DBTX) error {
		_, insertErr := sp.Exec(ctx, `
			INSERT INTO repository_storage_operations (
				repository_id, operation_type, token, storage_set_id,
				source_owner, source_repo, source_user_id,
				target_user_id, target_owner, target_repo
			) VALUES ($1, 'move', $2, 's1',
				'source-owner', 'malformed-storage-move', $3,
				$4, NULL, NULL)
		`, repoID, strings.Repeat("a", 64), ownerID, targetID)
		return insertErr
	})
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	assert.Equal(t, "23514", pgErr.Code)

	// Keep q referenced so this regression remains coupled to the production
	// schema/query fixture rather than an ad-hoc table definition.
	_, err = q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
}

func TestRepositoryStorageOperationFencesMutationUntilMatchingTransaction(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	owner := uniqueTestUsername(t)
	ownerID := mustCreateUser(t, pool, owner)
	repository, err := q.CreateRepo(ctx, CreateRepoParams{
		StorageSetID: "s1", UserID: pgtype.Int8{Int64: ownerID, Valid: true},
		Name: "storage-fenced", LowerName: "storage-fenced", Description: "",
		IsPublic: true, DefaultBookmark: "main",
	})
	require.NoError(t, err)
	token := strings.Repeat("b", 64)
	_, err = pool.Exec(ctx, `
		INSERT INTO repository_storage_operations (
			repository_id, operation_type, token, storage_set_id,
			source_owner, source_repo, source_user_id
		) VALUES ($1, 'delete', $2, 's1', $3, $4, $5)
	`, repository.ID, token, owner, repository.Name, ownerID)
	require.NoError(t, err)

	mutationErr := mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, updateErr := spQ.ArchiveRepo(ctx, repository.ID)
		return updateErr
	})
	var pgErr *pgconn.PgError
	require.ErrorAs(t, mutationErr, &pgErr)
	assert.Equal(t, "55006", pgErr.Code)
	assert.Contains(t, pgErr.Message, "storage operation")

	_, err = pool.Exec(ctx, `SELECT set_config('smithers.repository_storage_operation_token', $1, TRUE)`, token)
	require.NoError(t, err)
	require.NoError(t, q.DeleteRepo(ctx, repository.ID))

	var intentStillPresent bool
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM repository_storage_operations WHERE repository_id = $1)
	`, repository.ID).Scan(&intentStillPresent))
	assert.True(t, intentStillPresent, "repository deletion must not cascade away its recovery handle")
}

func TestOwnerHardDeleteRequiresRepositoriesToBeSettledFirst(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, err := pool.Exec(ctx, `
		UPDATE legacy_mutation_fence_control
		SET enforce_repository_storage = TRUE, updated_at = NOW()
		WHERE singleton
	`)
	require.NoError(t, err)
	ownerID := mustCreateUser(t, pool, uniqueTestUsername(t))
	repoID := mustCreateRepo(t, pool, ownerID, "owner-delete-fence")

	deleteErr := mustExpectError(t, pool, func(sp DBTX) error {
		_, err := sp.Exec(ctx, `DELETE FROM users WHERE id = $1`, ownerID)
		return err
	})
	var pgErr *pgconn.PgError
	require.ErrorAs(t, deleteErr, &pgErr)
	assert.Equal(t, "55006", pgErr.Code)
	assert.Contains(t, pgErr.Message, "repositories or provisioning operations still exist")

	mustDurablyDeleteRepoForTest(t, pool, repoID)
	_, err = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, ownerID)
	require.NoError(t, err)
	// Keep q coupled to the generated query surface used by the service.
	_, err = q.GetUserByID(ctx, ownerID)
	require.Error(t, err)
}

func TestRepositoryStorageOperationRejectsDirectDeleteAndOwnershipChange(t *testing.T) {
	ctx := context.Background()
	_, tx := newQueries(t)
	_, err := tx.Exec(ctx, `
		UPDATE legacy_mutation_fence_control
		SET enforce_repository_storage = TRUE, updated_at = NOW()
		WHERE singleton
	`)
	require.NoError(t, err)
	sourceID := mustCreateUser(t, tx, uniqueTestUsername(t))
	targetID := mustCreateUser(t, tx, uniqueTestUsername(t))
	repoID := mustCreateRepo(t, tx, sourceID, "direct-mutation-fence")

	deleteErr := mustExpectError(t, tx, func(sp DBTX) error {
		_, err := sp.Exec(ctx, `DELETE FROM repositories WHERE id = $1`, repoID)
		return err
	})
	var pgErr *pgconn.PgError
	require.ErrorAs(t, deleteErr, &pgErr)
	assert.Equal(t, "55006", pgErr.Code)
	assert.Contains(t, pgErr.Message, "authorized durable storage operation")

	moveErr := mustExpectError(t, tx, func(sp DBTX) error {
		_, err := sp.Exec(ctx,
			`UPDATE repositories SET user_id = $1, org_id = NULL WHERE id = $2`, targetID, repoID)
		return err
	})
	require.ErrorAs(t, moveErr, &pgErr)
	assert.Equal(t, "55006", pgErr.Code)
	assert.Contains(t, pgErr.Message, "ownership change")
}

func TestRepositoryStorageCompatibilityAllowsOnlyUnjournaledLegacyMutations(t *testing.T) {
	ctx := context.Background()
	_, tx := newQueries(t)
	_, err := tx.Exec(ctx, `
		UPDATE legacy_mutation_fence_control
		SET enforce_repository_storage = FALSE, updated_at = NOW()
		WHERE singleton
	`)
	require.NoError(t, err)
	sourceID := mustCreateUser(t, tx, uniqueTestUsername(t))
	targetID := mustCreateUser(t, tx, uniqueTestUsername(t))
	repoID := mustCreateRepo(t, tx, sourceID, "legacy-direct-mutation")

	_, err = tx.Exec(ctx,
		`UPDATE repositories SET user_id = $1, org_id = NULL WHERE id = $2`, targetID, repoID)
	require.NoError(t, err, "expand phase must admit the previous binary's direct ownership transfer")
	_, err = tx.Exec(ctx, `DELETE FROM repositories WHERE id = $1`, repoID)
	require.NoError(t, err, "expand phase must admit the previous binary's direct repository delete")
	legacyOwnerID := mustCreateUser(t, tx, uniqueTestUsername(t))
	legacyRepoID := mustCreateRepo(t, tx, legacyOwnerID, "legacy-owner-cascade")
	_, err = tx.Exec(ctx, `DELETE FROM users WHERE id = $1`, legacyOwnerID)
	require.NoError(t, err, "expand phase must preserve the previous binary's owner cascade")

	var exists bool
	require.NoError(t, tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM repositories WHERE id = $1)`, repoID).Scan(&exists))
	assert.False(t, exists)
	require.NoError(t, tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM repositories WHERE id = $1)`, legacyRepoID).Scan(&exists))
	assert.False(t, exists)
}

func TestRepositoryStorageOperationRejectsMismatchedMoveTarget(t *testing.T) {
	ctx := context.Background()
	_, tx := newQueries(t)
	sourceName := uniqueTestUsername(t)
	sourceID := mustCreateUser(t, tx, sourceName)
	targetName := uniqueTestUsername(t)
	targetID := mustCreateUser(t, tx, targetName)
	wrongTargetID := mustCreateUser(t, tx, uniqueTestUsername(t))
	repoID := mustCreateRepo(t, tx, sourceID, "mismatched-move-target")
	token := newRepositoryStorageOperationToken(t)
	_, err := tx.Exec(ctx, `
		INSERT INTO repository_storage_operations (
			repository_id, operation_type, token, storage_set_id,
			source_owner, source_repo, source_user_id,
			target_owner, target_repo, target_user_id
		) VALUES ($1, 'move', $2, 's1', $3, $4, $5, $6, $4, $7)
	`, repoID, token, sourceName, "mismatched-move-target", sourceID, targetName, targetID)
	require.NoError(t, err)
	_, err = tx.Exec(ctx,
		`SELECT set_config('smithers.repository_storage_operation_token', $1, TRUE)`, token)
	require.NoError(t, err)

	moveErr := mustExpectError(t, tx, func(sp DBTX) error {
		_, updateErr := sp.Exec(ctx,
			`UPDATE repositories SET user_id = $1, org_id = NULL WHERE id = $2`, wrongTargetID, repoID)
		return updateErr
	})
	var pgErr *pgconn.PgError
	require.ErrorAs(t, moveErr, &pgErr)
	assert.Equal(t, "55006", pgErr.Code)
	assert.Contains(t, pgErr.Message, "ownership change")
}

func TestRepositoryStorageIdentityAndPlacementAreImmutable(t *testing.T) {
	ctx := context.Background()
	_, tx := newQueries(t)
	ownerID := mustCreateUser(t, tx, uniqueTestUsername(t))
	repoID := mustCreateRepo(t, tx, ownerID, "immutable-storage-identity")

	for name, statement := range map[string]string{
		"name":        `UPDATE repositories SET name = 'renamed', lower_name = 'renamed' WHERE id = $1`,
		"lower_name":  `UPDATE repositories SET lower_name = 'wrong-lower' WHERE id = $1`,
		"storage_set": `UPDATE repositories SET storage_set_id = 's2' WHERE id = $1`,
	} {
		t.Run(name, func(t *testing.T) {
			mutationErr := mustExpectError(t, tx, func(sp DBTX) error {
				_, err := sp.Exec(ctx, statement, repoID)
				return err
			})
			var pgErr *pgconn.PgError
			require.ErrorAs(t, mutationErr, &pgErr)
			assert.Equal(t, "0A000", pgErr.Code)
			assert.Contains(t, pgErr.Message, "immutable")
		})
	}
}

func TestRepositoryStorageOperationAllowsMetadataOnlyWhenNoIntentExists(t *testing.T) {
	ctx := context.Background()
	_, tx := newQueries(t)
	ownerName := uniqueTestUsername(t)
	ownerID := mustCreateUser(t, tx, ownerName)
	repoID := mustCreateRepo(t, tx, ownerID, "metadata-operation-fence")

	_, err := tx.Exec(ctx, `UPDATE repositories SET description = 'allowed' WHERE id = $1`, repoID)
	require.NoError(t, err)
	token := newRepositoryStorageOperationToken(t)
	_, err = tx.Exec(ctx, `
		INSERT INTO repository_storage_operations (
			repository_id, operation_type, token, storage_set_id,
			source_owner, source_repo, source_user_id
		) VALUES ($1, 'delete', $2, 's1', $3, $4, $5)
	`, repoID, token, ownerName, "metadata-operation-fence", ownerID)
	require.NoError(t, err)

	metadataErr := mustExpectError(t, tx, func(sp DBTX) error {
		_, updateErr := sp.Exec(ctx,
			`UPDATE repositories SET description = 'blocked' WHERE id = $1`, repoID)
		return updateErr
	})
	var pgErr *pgconn.PgError
	require.ErrorAs(t, metadataErr, &pgErr)
	assert.Equal(t, "55006", pgErr.Code)
	assert.Contains(t, pgErr.Message, "already in progress")
}
