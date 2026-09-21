package db

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func ownerNamespaceMigrationSQL(t *testing.T) string {
	t.Helper()

	contents, err := os.ReadFile(filepath.Join(findMigrationsDir(t), "20260718000100_unify_owner_namespace.sql"))
	require.NoError(t, err)
	return string(contents)
}

// newOwnerNamespaceMigrationFixture creates the minimum pre-20260718000100 schema in
// an isolated PostgreSQL schema. Keeping this fixture in a transaction lets us
// exercise the real migration, including its failure atomicity, without
// changing the shared schema used by the rest of the package.
func newOwnerNamespaceMigrationFixture(t *testing.T) pgx.Tx {
	t.Helper()

	ctx := context.Background()
	tx, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	t.Cleanup(func() {
		err := tx.Rollback(context.Background())
		if err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			require.NoError(t, err)
		}
	})

	schemaName := "owner_namespace_" + randSlug(t)
	_, err = tx.Exec(ctx, fmt.Sprintf(`CREATE SCHEMA %q`, schemaName))
	require.NoError(t, err)
	_, err = tx.Exec(ctx, fmt.Sprintf(`SET LOCAL search_path TO %q`, schemaName))
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `
		CREATE TABLE users (
			id BIGINT PRIMARY KEY,
			username VARCHAR(255) NOT NULL DEFAULT '',
			lower_username VARCHAR(255) NOT NULL UNIQUE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
		CREATE TABLE organizations (
			id BIGINT PRIMARY KEY,
			name VARCHAR(255) NOT NULL DEFAULT '',
			lower_name VARCHAR(255) NOT NULL UNIQUE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`)
	require.NoError(t, err)
	return tx
}

func TestOwnerNamespaceMigrationRejectsLegacyCollisionsAtomically(t *testing.T) {
	ctx := context.Background()
	tx := newOwnerNamespaceMigrationFixture(t)

	_, err := tx.Exec(ctx, `
		INSERT INTO users (id, username, lower_username) VALUES (1, 'Zeta', 'zeta'), (2, 'alpha', 'alpha');
		INSERT INTO organizations (id, name, lower_name) VALUES (1, 'zeta', 'zeta'), (2, 'ALPHA', 'alpha');
	`)
	require.NoError(t, err)

	// A savepoint lets the test inspect the pre-migration rows after the
	// migration deliberately raises its actionable exception.
	sp, err := tx.Begin(ctx)
	require.NoError(t, err)
	_, migrationErr := sp.Exec(ctx, ownerNamespaceMigrationSQL(t))
	require.Error(t, migrationErr)
	require.NoError(t, sp.Rollback(ctx))

	var pgErr *pgconn.PgError
	require.ErrorAs(t, migrationErr, &pgErr)
	assert.Equal(t, "23505", pgErr.Code)
	assert.Contains(t, pgErr.Message, "2 normalized slug collision(s)")
	assert.Contains(t, pgErr.Detail, "alpha, zeta")
	assert.Contains(t, pgErr.Hint, "move its repo-host namespace")

	var namespaceTableMissing bool
	require.NoError(t, tx.QueryRow(ctx, `SELECT TO_REGCLASS('owner_namespaces') IS NULL`).Scan(&namespaceTableMissing))
	assert.True(t, namespaceTableMissing, "failed migration must not leave a partial namespace table")

	var owners int64
	require.NoError(t, tx.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM organizations)`).Scan(&owners))
	assert.Equal(t, int64(4), owners, "failed migration must preserve every legacy owner")
}

func TestOwnerNamespaceMigrationBackfillsCanonicalClaims(t *testing.T) {
	ctx := context.Background()
	tx := newOwnerNamespaceMigrationFixture(t)

	_, err := tx.Exec(ctx, `
		INSERT INTO users (id, username, lower_username) VALUES (11, 'Alice', 'alice');
		INSERT INTO organizations (id, name, lower_name) VALUES (22, 'ACME', 'acme');
	`)
	require.NoError(t, err)
	require.NoError(t, func() error {
		_, execErr := tx.Exec(ctx, ownerNamespaceMigrationSQL(t))
		return execErr
	}())

	rows, err := tx.Query(ctx, `
		SELECT lower_slug, owner_type, user_id, org_id
		FROM owner_namespaces
		ORDER BY lower_slug
	`)
	require.NoError(t, err)
	defer rows.Close()

	type claim struct {
		slug      string
		ownerType string
		userID    pgtype.Int8
		orgID     pgtype.Int8
	}
	var claims []claim
	for rows.Next() {
		var c claim
		require.NoError(t, rows.Scan(&c.slug, &c.ownerType, &c.userID, &c.orgID))
		claims = append(claims, c)
	}
	require.NoError(t, rows.Err())
	require.Len(t, claims, 2)
	assert.Equal(t, "acme", claims[0].slug)
	assert.Equal(t, "org", claims[0].ownerType)
	assert.Equal(t, int64(22), claims[0].orgID.Int64)
	assert.Equal(t, "alice", claims[1].slug)
	assert.Equal(t, "user", claims[1].ownerType)
	assert.Equal(t, int64(11), claims[1].userID.Int64)
}

func TestOwnerNamespaceCreateRenameAndDeleteLifecycle(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)

	reservedByUser := uniqueTestUsername(t)
	userID := mustCreateUser(t, pool, reservedByUser)
	oldOrgSlug := uniqueTestUsername(t)
	newOrgSlug := uniqueTestUsername(t)
	org, err := q.CreateOrganization(ctx, CreateOrganizationParams{
		Name: oldOrgSlug, LowerName: oldOrgSlug, Description: "", Visibility: "public",
	})
	require.NoError(t, err)

	renameErr := mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, updateErr := spQ.UpdateOrganization(ctx, UpdateOrganizationParams{
			ID: org.ID, Name: reservedByUser, LowerName: reservedByUser,
			Description: "", Visibility: "public", Website: "", Location: "",
		})
		return updateErr
	})
	var pgErr *pgconn.PgError
	require.ErrorAs(t, renameErr, &pgErr)
	assert.Equal(t, "0A000", pgErr.Code)
	assert.Contains(t, pgErr.Message, "owner namespace is immutable")

	userRenameErr := mustExpectError(t, pool, func(sp DBTX) error {
		_, updateErr := sp.Exec(ctx,
			`UPDATE users SET lower_username = $1 WHERE id = $2`, oldOrgSlug, userID,
		)
		return updateErr
	})
	require.ErrorAs(t, userRenameErr, &pgErr)
	assert.Equal(t, "0A000", pgErr.Code)
	assert.Contains(t, pgErr.Message, "user owner namespace is immutable")

	userCaseOnlyErr := mustExpectError(t, pool, func(sp DBTX) error {
		_, updateErr := sp.Exec(ctx,
			`UPDATE users SET username = UPPER(username) WHERE id = $1`, userID,
		)
		return updateErr
	})
	require.ErrorAs(t, userCaseOnlyErr, &pgErr)
	assert.Equal(t, "0A000", pgErr.Code)

	var originalClaimOrgID int64
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT org_id FROM owner_namespaces WHERE lower_slug = $1`, oldOrgSlug,
	).Scan(&originalClaimOrgID))
	assert.Equal(t, org.ID, originalClaimOrgID)

	renameErr = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, updateErr := spQ.UpdateOrganization(ctx, UpdateOrganizationParams{
			ID: org.ID, Name: newOrgSlug, LowerName: newOrgSlug,
			Description: "", Visibility: "public", Website: "", Location: "",
		})
		return updateErr
	})
	require.ErrorAs(t, renameErr, &pgErr)
	assert.Equal(t, "0A000", pgErr.Code)

	var oldClaimExists bool
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM owner_namespaces WHERE lower_slug = $1)`, oldOrgSlug,
	).Scan(&oldClaimExists))
	assert.True(t, oldClaimExists)
	var renamedClaimExists bool
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM owner_namespaces WHERE lower_slug = $1)`, newOrgSlug,
	).Scan(&renamedClaimExists))
	assert.False(t, renamedClaimExists)

	// Freeze exact spelling too: a case-only name change resolves to a distinct
	// path on Linux even when the normalized slug is unchanged.
	caseOnlyErr := mustExpectError(t, pool, func(sp DBTX) error {
		_, updateErr := sp.Exec(ctx, `UPDATE organizations SET name = UPPER(name) WHERE id = $1`, org.ID)
		return updateErr
	})
	require.ErrorAs(t, caseOnlyErr, &pgErr)
	assert.Equal(t, "0A000", pgErr.Code)

	// Hard deletion cascades the canonical claim, so the exact slug can be
	// claimed again. Soft-deleted users intentionally retain theirs.
	require.NoError(t, q.DeleteOrganization(ctx, org.ID))
	oldSlugUserID := mustCreateUser(t, pool, oldOrgSlug)
	assert.NotZero(t, oldSlugUserID)

	// Suspension is a soft delete and deliberately does not release a public
	// identity. Otherwise an organization could impersonate historical links
	// belonging to the suspended user.
	require.NoError(t, q.SuspendUser(ctx, userID))
	softDeleteConflict := mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, createErr := spQ.CreateOrganization(ctx, CreateOrganizationParams{
			Name: reservedByUser, LowerName: reservedByUser, Description: "", Visibility: "public",
		})
		return createErr
	})
	require.ErrorAs(t, softDeleteConflict, &pgErr)
	assert.Equal(t, "owner_namespaces_pkey", pgErr.ConstraintName)

	var userClaimID int64
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT user_id FROM owner_namespaces WHERE lower_slug = $1`, reservedByUser,
	).Scan(&userClaimID))
	assert.Equal(t, userID, userClaimID)
}

func TestOwnerNamespaceConcurrentCrossTypeCreateHasOneWinner(t *testing.T) {
	ctx := context.Background()
	slug := uniqueTestUsername(t)

	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM organizations WHERE lower_name = $1`, slug)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM users WHERE lower_username = $1`, slug)
	})

	type result struct {
		ownerType string
		err       error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		_, err := sharedPool.Exec(ctx, `
			INSERT INTO users (username, lower_username, email, lower_email, display_name)
			VALUES ($1, $1, $2, $2, $1)
		`, slug, slug+"@owner-namespace.test")
		results <- result{ownerType: "user", err: err}
	}()
	go func() {
		defer wg.Done()
		<-start
		_, err := sharedPool.Exec(ctx, `
			INSERT INTO organizations (name, lower_name, description, visibility)
			VALUES ($1, $1, '', 'public')
		`, slug)
		results <- result{ownerType: "org", err: err}
	}()
	close(start)
	wg.Wait()
	close(results)

	var winner string
	var failures int
	for res := range results {
		if res.err == nil {
			require.Empty(t, winner, "both cross-type creators committed")
			winner = res.ownerType
			continue
		}
		failures++
		var pgErr *pgconn.PgError
		require.ErrorAs(t, res.err, &pgErr)
		assert.Equal(t, "23505", pgErr.Code)
		assert.Equal(t, "owner_namespaces_pkey", pgErr.ConstraintName)
	}
	require.NotEmpty(t, winner)
	assert.Equal(t, 1, failures)

	var ownerType string
	var hasUser, hasOrg bool
	require.NoError(t, sharedPool.QueryRow(ctx, `
		SELECT owner_type, user_id IS NOT NULL, org_id IS NOT NULL
		FROM owner_namespaces
		WHERE lower_slug = $1
	`, slug).Scan(&ownerType, &hasUser, &hasOrg))
	assert.Equal(t, winner, ownerType)
	assert.NotEqual(t, hasUser, hasOrg)
}

func TestOwnerNamespaceRepositoryAuthorizationQueriesFailClosedWithoutClaim(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	owner := uniqueTestUsername(t)
	ownerID := mustCreateUser(t, pool, owner)
	repoID := mustCreateRepo(t, pool, ownerID, "canonical-authz-repo")

	byName, err := q.GetRepoByOwnerAndName(ctx, GetRepoByOwnerAndNameParams{
		Owner: strings.ToUpper(owner), Name: "CANONICAL-AUTHZ-REPO",
	})
	require.NoError(t, err)
	assert.Equal(t, repoID, byName.ID)

	byLowerName, err := q.GetRepoByOwnerAndLowerName(ctx, GetRepoByOwnerAndLowerNameParams{
		Owner: strings.ToUpper(owner), LowerName: "CANONICAL-AUTHZ-REPO",
	})
	require.NoError(t, err)
	assert.Equal(t, repoID, byLowerName.ID)

	// Synthetic corruption/legacy state: a repository row is not enough to
	// authorize owner/repo access. Both HTTP and SSH lookup queries must first
	// resolve the one canonical namespace claim and otherwise fail closed.
	_, err = pool.Exec(ctx, `DELETE FROM owner_namespaces WHERE lower_slug = $1`, owner)
	require.NoError(t, err)
	_, err = q.GetRepoByOwnerAndName(ctx, GetRepoByOwnerAndNameParams{
		Owner: owner, Name: "canonical-authz-repo",
	})
	assert.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetRepoByOwnerAndLowerName(ctx, GetRepoByOwnerAndLowerNameParams{
		Owner: owner, LowerName: "canonical-authz-repo",
	})
	assert.ErrorIs(t, err, pgx.ErrNoRows)

	stillPresent, err := q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, repoID, stillPresent.ID)
}
