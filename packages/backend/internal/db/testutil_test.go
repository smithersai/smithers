package db

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/database"
)

const defaultTestDatabaseURL = "postgres://smithers:smithers@localhost:5432/smithers_test?sslmode=disable"

// sharedPool is initialized once in TestMain and reused across all tests.
var sharedPool *pgxpool.Pool

// resolveDBTestDatabaseURL returns the database URL for db package tests.
// Precedence: SMITHERS_TEST_DB_DATABASE_URL -> SMITHERS_TEST_DATABASE_URL -> default.
func resolveDBTestDatabaseURL(getenv func(string) string) string {
	if v := getenv("SMITHERS_TEST_DB_DATABASE_URL"); v != "" {
		return v
	}
	if v := getenv("SMITHERS_TEST_DATABASE_URL"); v != "" {
		return v
	}
	return defaultTestDatabaseURL
}

func TestMain(m *testing.M) {
	databaseURL := resolveDBTestDatabaseURL(os.Getenv)

	// Ensure the test database exists.
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "bad database URL: %v\n", err)
		os.Exit(1)
	}
	dbName := strings.TrimPrefix(parsed.Path, "/")
	adminURL := *parsed
	adminURL.Path = "/postgres"
	adminConn, err := pgx.Connect(context.Background(), adminURL.String())
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot connect to admin database: %v\n", err)
		os.Exit(1)
	}
	var exists bool
	_ = adminConn.QueryRow(context.Background(), `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, dbName).Scan(&exists)
	if !exists {
		_, _ = adminConn.Exec(context.Background(), `CREATE DATABASE "`+strings.ReplaceAll(dbName, `"`, `""`)+`"`)
	}
	adminConn.Close(context.Background())

	// Apply the full schema once using a standalone connection.
	schemaBytes, err := os.ReadFile(findSchemaPath())
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot read schema: %v\n", err)
		os.Exit(1)
	}
	schemaConn, err := pgx.Connect(context.Background(), databaseURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot connect to test db for schema setup: %v\n", err)
		os.Exit(1)
	}
	// Terminate all other connections to the test database before dropping the
	// schema. Concurrent connections holding any lock on public-schema objects
	// will cause DROP SCHEMA CASCADE to deadlock.
	_, _ = schemaConn.Exec(context.Background(),
		`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`)
	combined := `DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;` + "\n" + string(schemaBytes)
	if _, err := schemaConn.Exec(context.Background(), combined); err != nil {
		fmt.Fprintf(os.Stderr, "schema setup failed: %v\n", err)
		os.Exit(1)
	}
	// Legacy query/fixture tests intentionally exercise generated repository
	// queries in isolation from repo-host. Production rejects every unjournaled
	// repository INSERT; this test-only trigger synthesizes and immediately
	// settles an exact operation when the pool-only test GUC is enabled. Focused
	// provisioning-fence tests disable the GUC and exercise the real boundary.
	if _, err := schemaConn.Exec(context.Background(), repositoryInsertFixtureTriggerSQL); err != nil {
		fmt.Fprintf(os.Stderr, "repository fixture trigger setup failed: %v\n", err)
		os.Exit(1)
	}
	schemaConn.Close(context.Background())

	// Create a shared pool for all tests.
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "bad pool config: %v\n", err)
		os.Exit(1)
	}
	cfg.MaxConns = 20
	cfg.MinConns = 2
	cfg.AfterConnect = func(_ context.Context, conn *pgx.Conn) error {
		database.ConfigureSQLCTypes(conn.TypeMap())
		_, err := conn.Exec(context.Background(),
			`SELECT set_config('smithers.test_repository_insert', 'on', FALSE)`)
		return err
	}
	sharedPool, err = pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot create pool: %v\n", err)
		os.Exit(1)
	}

	if err := resetTestData(context.Background(), sharedPool); err != nil {
		fmt.Fprintf(os.Stderr, "initial test database cleanup failed: %v\n", err)
		sharedPool.Close()
		os.Exit(1)
	}

	code := m.Run()

	if err := resetTestData(context.Background(), sharedPool); err != nil {
		fmt.Fprintf(os.Stderr, "final test database cleanup failed: %v\n", err)
		code = 1
	}

	sharedPool.Close()
	os.Exit(code)
}

func findSchemaPath() string {
	candidates := []string{
		filepath.Join("..", "..", "db", "schema.sql"),
		filepath.Join("db", "schema.sql"),
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return candidates[0] // will fail at ReadFile
}

func resetTestData(ctx context.Context, db DBTX) error {
	_, err := db.Exec(ctx, `
		TRUNCATE
			sandbox_egress_audit,
			storage_deletion_queue,
			repository_provisioning_operations,
			repository_storage_operations,
			agent_parts,
			agent_messages,
			agent_sessions,
			lfs_locks,
			lfs_objects,
			lfs_meta_objects,
			webhook_deliveries,
			webhooks,
			watches,
			stars,
			notifications,
			user_notification_preferences,
			user_devices,
			commit_statuses,
			workflow_run_logs,
			workflow_logs,
			workflow_tasks,
			workflow_steps,
			workflow_runs,
			workflow_definitions,
			runner_pool,
			reactions,
			mentions,
			protected_bookmarks,
			jj_operations,
			conflicts,
			changes,
			bookmarks,
			landing_request_comments,
			landing_request_reviews,
			landing_request_changes,
			landing_tasks,
			landing_requests,
			issue_artifacts,
			pinned_issues,
			issue_dependencies,
			issue_events,
			issue_assignees,
			issue_labels,
			issue_comments,
			labels,
			issues,
			milestones,
			collaborators,
			team_repos,
			team_members,
			teams,
			org_members,
			workspace_shares,
			email_verification_tokens,
			oauth_accounts,
			ssh_keys,
			access_tokens,
			email_addresses,
			linear_oauth_setups,
			auth_sessions,
			oauth_states,
			auth_nonces,
			code_search_documents,
			search_rate_limits,
			wiki_pages,
			linear_comment_map,
			linear_issue_map,
			linear_sync_ops,
			linear_integrations,
			organization_secrets,
			organization_variables,
			billing_credit_ledger,
			billing_credit_balances,
			billing_usage_counters,
			billing_entitlements,
			billing_subscriptions,
			billing_accounts,
			stripe_processed_events,
			_sync_queue,
			_id_remap,
			repositories,
			organizations,
			users
		RESTART IDENTITY CASCADE
	`)
	return err
}

const repositoryInsertFixtureTriggerSQL = `
CREATE OR REPLACE FUNCTION test_authorize_repository_insert()
RETURNS TRIGGER AS $$
DECLARE
    v_token TEXT;
    v_owner TEXT;
    v_actor_id BIGINT;
    v_prior_role TEXT;
    v_added_membership BOOLEAN := FALSE;
    v_elevated_membership BOOLEAN := FALSE;
    v_source_owner TEXT;
    v_source_repo TEXT;
    v_source_storage_set TEXT;
BEGIN
    IF current_setting('smithers.test_repository_insert', TRUE) <> 'on'
       OR EXISTS (SELECT 1 FROM repository_provisioning_operations WHERE repository_id = NEW.id) THEN
        RETURN NEW;
    END IF;
    SELECT COALESCE(u.username, o.name) INTO v_owner
    FROM (SELECT NEW.user_id AS user_id, NEW.org_id AS org_id) identity
    LEFT JOIN users u ON u.id = identity.user_id
    LEFT JOIN organizations o ON o.id = identity.org_id;
    v_token := ENCODE(DIGEST(
        FORMAT('test-repository-provision:%s:%s', NEW.id, clock_timestamp()),
        'sha256'
    ), 'hex');
    IF NEW.is_fork THEN
        SELECT COALESCE(u.username, o.name), r.name, r.storage_set_id
        INTO v_source_owner, v_source_repo, v_source_storage_set
        FROM repositories r
        LEFT JOIN users u ON u.id = r.user_id
        LEFT JOIN organizations o ON o.id = r.org_id
        WHERE r.id = NEW.fork_id;
    END IF;
    IF NEW.user_id IS NOT NULL THEN
        v_actor_id := NEW.user_id;
    ELSE
        SELECT om.user_id INTO v_actor_id
        FROM org_members om
        WHERE om.organization_id = NEW.org_id AND om.role = 'owner'
        ORDER BY om.user_id
        LIMIT 1;
        IF v_actor_id IS NULL THEN
            -- Ordinary DB query tests historically inserted org-owned fixture
            -- repositories without first constructing an owner. Temporarily
            -- supply one so the production authorization trigger is still
            -- exercised; restore the test's membership state immediately
            -- after the durable intent has been validated.
            SELECT u.id, om.role INTO v_actor_id, v_prior_role
            FROM users u
            LEFT JOIN org_members om
              ON om.organization_id = NEW.org_id AND om.user_id = u.id
            ORDER BY (om.user_id IS NULL) DESC, u.id
            LIMIT 1;
            IF v_actor_id IS NULL THEN
                INSERT INTO users (
                    username, lower_username, email, lower_email, display_name
                ) VALUES (
                    FORMAT('test-provision-owner-%s-%s', NEW.org_id, NEW.id),
                    FORMAT('test-provision-owner-%s-%s', NEW.org_id, NEW.id),
                    FORMAT('test-provision-owner-%s-%s@example.invalid', NEW.org_id, NEW.id),
                    FORMAT('test-provision-owner-%s-%s@example.invalid', NEW.org_id, NEW.id),
                    'Repository fixture owner'
                ) RETURNING id INTO v_actor_id;
            END IF;
            IF v_prior_role IS NULL THEN
                INSERT INTO org_members (organization_id, user_id, role)
                VALUES (NEW.org_id, v_actor_id, 'owner');
                v_added_membership := TRUE;
            ELSE
                UPDATE org_members SET role = 'owner'
                WHERE organization_id = NEW.org_id AND user_id = v_actor_id;
                v_elevated_membership := TRUE;
            END IF;
        END IF;
    END IF;
    INSERT INTO repository_provisioning_operations (
        repository_id, operation_type, token, actor_id, storage_set_id,
        owner_name, user_id, org_id, name, lower_name, description,
        is_public, default_bookmark, is_fork, fork_id,
        source_repository_id, source_owner, source_repo, source_storage_set_id,
        publish_ready
    ) VALUES (
        NEW.id, CASE WHEN NEW.is_fork THEN 'fork' ELSE 'init' END,
        v_token, v_actor_id, NEW.storage_set_id, v_owner, NEW.user_id, NEW.org_id,
        NEW.name, NEW.lower_name, NEW.description, NEW.is_public,
        NEW.default_bookmark, NEW.is_fork, NEW.fork_id,
        CASE WHEN NEW.is_fork THEN NEW.fork_id END,
        v_source_owner, v_source_repo, v_source_storage_set, TRUE
    );
    IF v_elevated_membership THEN
        UPDATE org_members SET role = v_prior_role
        WHERE organization_id = NEW.org_id AND user_id = v_actor_id;
    ELSIF v_added_membership THEN
        DELETE FROM org_members
        WHERE organization_id = NEW.org_id AND user_id = v_actor_id;
    END IF;
    PERFORM set_config('smithers.repository_provisioning_token', v_token, TRUE);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER aaa_test_authorize_repository_insert
    BEFORE INSERT ON repositories
    FOR EACH ROW EXECUTE FUNCTION test_authorize_repository_insert();

CREATE OR REPLACE FUNCTION test_settle_repository_insert()
RETURNS TRIGGER AS $$
DECLARE
    v_actor_id BIGINT;
BEGIN
    IF current_setting('smithers.test_repository_insert', TRUE) = 'on' THEN
        SELECT actor_id INTO v_actor_id
        FROM repository_provisioning_operations
        WHERE repository_id = NEW.id;
        DELETE FROM repository_provisioning_operations WHERE repository_id = NEW.id;
        IF NEW.org_id IS NOT NULL AND v_actor_id IS NOT NULL THEN
            DELETE FROM users
            WHERE id = v_actor_id
              AND username = FORMAT('test-provision-owner-%s-%s', NEW.org_id, NEW.id);
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER zzz_test_settle_repository_insert
    AFTER INSERT ON repositories
    FOR EACH ROW EXECUTE FUNCTION test_settle_repository_insert();
`

func newQueries(t *testing.T) (*Queries, DBTX) {
	t.Helper()

	tx, err := sharedPool.Begin(context.Background())
	require.NoError(t, err, "failed to start test transaction")

	t.Cleanup(func() {
		err := tx.Rollback(context.Background())
		if err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			require.NoError(t, err, "failed to rollback test transaction")
		}
	})

	return New(tx), tx
}

func schemaPath(t *testing.T) string {
	t.Helper()
	return findSchemaPath()
}

func mustCreateUser(t *testing.T, pool DBTX, username string) int64 {
	t.Helper()

	lowerUsername := strings.ToLower(username)
	lowerEmail := lowerUsername + "@example.com"

	var id int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO users (username, lower_username, email, lower_email, display_name) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		username,
		lowerUsername,
		username+"@example.com",
		lowerEmail,
		username,
	).Scan(&id)
	require.NoError(t, err)

	return id
}

func mustCreateRepo(t *testing.T, pool DBTX, userID int64, name string) int64 {
	t.Helper()

	lowerName := strings.ToLower(name)

	var id int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (user_id, name, lower_name, description, storage_set_id, is_public, default_bookmark, next_issue_number) VALUES ($1, $2, $3, '', 's1', TRUE, 'main', 1) RETURNING id`,
		userID,
		name,
		lowerName,
	).Scan(&id)
	require.NoError(t, err)

	return id
}

// newRepositoryStorageOperationToken returns the same 64-character lowercase
// token shape used by repo-host journals in production. Tests must exercise the
// database authorization boundary instead of bypassing the durable-operation
// trigger with an ad-hoc session setting.
func newRepositoryStorageOperationToken(t *testing.T) string {
	t.Helper()
	var raw [32]byte
	_, err := rand.Read(raw[:])
	require.NoError(t, err)
	return hex.EncodeToString(raw[:])
}

// mustDurablyDeleteRepoForTest performs the metadata half of the production
// delete protocol: persist the exact stable-id/source identity, authorize only
// this transaction, delete the row, then remove the settled intent. It does not
// contact repo-host and is therefore only suitable for database tests.
func mustDurablyDeleteRepoForTest(t *testing.T, tx DBTX, repositoryID int64) {
	t.Helper()
	pgxTx, ok := tx.(pgx.Tx)
	require.True(t, ok, "durable repository test helper requires one explicit transaction")
	tx = pgxTx
	ctx := context.Background()
	var (
		name   string
		owner  string
		userID pgtype.Int8
		orgID  pgtype.Int8
	)
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT r.name, COALESCE(u.username, o.name), r.user_id, r.org_id
		FROM repositories r
		LEFT JOIN users u ON u.id = r.user_id
		LEFT JOIN organizations o ON o.id = r.org_id
		WHERE r.id = $1
		FOR UPDATE OF r
	`, repositoryID).Scan(&name, &owner, &userID, &orgID))

	token := newRepositoryStorageOperationToken(t)
	_, err := tx.Exec(ctx, `
		INSERT INTO repository_storage_operations (
			repository_id, operation_type, token, storage_set_id,
			source_owner, source_repo, source_user_id, source_org_id
		) VALUES ($1, 'delete', $2, 's1', $3, $4, $5, $6)
	`, repositoryID, token, owner, name, userID, orgID)
	require.NoError(t, err)
	_, err = tx.Exec(ctx,
		`SELECT set_config('smithers.repository_storage_operation_token', $1, TRUE)`, token)
	require.NoError(t, err)
	require.NoError(t, New(tx).DeleteRepo(ctx, repositoryID))
	commandTag, err := tx.Exec(ctx,
		`DELETE FROM repository_storage_operations WHERE repository_id = $1 AND token = $2`,
		repositoryID, token)
	require.NoError(t, err)
	require.EqualValues(t, 1, commandTag.RowsAffected())
}

func mustDurablyDeleteRepoCommittedForTest(t *testing.T, pool *pgxpool.Pool, repositoryID int64) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below closes the transaction
	var exists bool
	require.NoError(t, tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM repositories WHERE id = $1)`, repositoryID).Scan(&exists))
	if exists {
		mustDurablyDeleteRepoForTest(t, tx, repositoryID)
	}
	require.NoError(t, tx.Commit(ctx))
}

// mustDurablyMoveRepoForTest performs the metadata half of an authorized
// ownership transfer. Exactly one target owner must be supplied.
func mustDurablyMoveRepoForTest(
	t *testing.T,
	tx DBTX,
	repositoryID int64,
	targetUserID pgtype.Int8,
	targetOrgID pgtype.Int8,
) {
	t.Helper()
	pgxTx, ok := tx.(pgx.Tx)
	require.True(t, ok, "durable repository test helper requires one explicit transaction")
	tx = pgxTx
	require.NotEqual(t, targetUserID.Valid, targetOrgID.Valid, "move target must have exactly one owner")
	ctx := context.Background()
	var (
		name        string
		sourceOwner string
		sourceUser  pgtype.Int8
		sourceOrg   pgtype.Int8
		targetOwner string
	)
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT r.name, COALESCE(u.username, o.name), r.user_id, r.org_id
		FROM repositories r
		LEFT JOIN users u ON u.id = r.user_id
		LEFT JOIN organizations o ON o.id = r.org_id
		WHERE r.id = $1
		FOR UPDATE OF r
	`, repositoryID).Scan(&name, &sourceOwner, &sourceUser, &sourceOrg))
	if targetUserID.Valid {
		require.NoError(t, tx.QueryRow(ctx,
			`SELECT username FROM users WHERE id = $1`, targetUserID.Int64).Scan(&targetOwner))
	} else {
		require.NoError(t, tx.QueryRow(ctx,
			`SELECT name FROM organizations WHERE id = $1`, targetOrgID.Int64).Scan(&targetOwner))
	}

	token := newRepositoryStorageOperationToken(t)
	_, err := tx.Exec(ctx, `
		INSERT INTO repository_storage_operations (
			repository_id, operation_type, token, storage_set_id,
			source_owner, source_repo, source_user_id, source_org_id,
			target_owner, target_repo, target_user_id, target_org_id
		) VALUES ($1, 'move', $2, 's1',
			$3, $4, $5, $6, $7, $4, $8, $9)
	`, repositoryID, token, sourceOwner, name, sourceUser, sourceOrg,
		targetOwner, targetUserID, targetOrgID)
	require.NoError(t, err)
	_, err = tx.Exec(ctx,
		`SELECT set_config('smithers.repository_storage_operation_token', $1, TRUE)`, token)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `
		UPDATE repositories SET user_id = $1, org_id = $2 WHERE id = $3
	`, targetUserID, targetOrgID, repositoryID)
	require.NoError(t, err)
	commandTag, err := tx.Exec(ctx,
		`DELETE FROM repository_storage_operations WHERE repository_id = $1 AND token = $2`,
		repositoryID, token)
	require.NoError(t, err)
	require.EqualValues(t, 1, commandTag.RowsAffected())
}

// mustCreateUserAndRepo creates a parent user and a repository owned by that user
// in a single call. It returns both IDs so callers always use dynamically assigned
// IDs instead of hard-coded values. This prevents FK constraint violations from
// missing parent entities — the root cause of SCHEMA-3.
func mustCreateUserAndRepo(t *testing.T, pool DBTX, username, repoName string) (userID int64, repoID int64) {
	t.Helper()

	userID = mustCreateUser(t, pool, username)
	repoID = mustCreateRepo(t, pool, userID, repoName)
	return userID, repoID
}

func mustCreateIssue(t *testing.T, q *Queries, repoID, authorID int64, title string) Issue {
	t.Helper()
	issue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        title,
		Body:         "",
		AuthorID:     authorID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)
	return issue
}

func mustCreateLandingRequest(t *testing.T, q *Queries, repoID, authorID int64, title string) LandingRequest {
	t.Helper()
	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          title,
		Body:           "",
		AuthorID:       authorID,
		TargetBookmark: "main",
		StackSize:      0,
	})
	require.NoError(t, err)
	return lr
}

func mustExec(t *testing.T, pool DBTX, query string, args ...any) {
	t.Helper()
	_, err := pool.Exec(context.Background(), query, args...)
	require.NoError(t, err)
}

// --- Unique identifier helpers ---
// These generate globally unique test identifiers to eliminate interference
// between tests that share the same database, even when running in parallel
// or when truncateAll is not called between subtests.

// testSeqCounter is an atomic counter for generating unique identifiers.
var testSeqCounter atomic.Int64

// uniqueTestUsername generates a unique username scoped to the calling test.
// Format: "t-{testName}-{seq}" truncated to fit database constraints.
func uniqueTestUsername(t *testing.T) string {
	t.Helper()
	seq := testSeqCounter.Add(1)
	// Use a short hash of test name to keep within reasonable length
	name := strings.ReplaceAll(t.Name(), "/", "-")
	// Truncate name part to keep total under 255 chars
	if len(name) > 40 {
		name = name[:40]
	}
	return fmt.Sprintf("t-%s-%d", strings.ToLower(name), seq)
}

// uniqueTestEmail generates a unique email address scoped to the calling test.
func uniqueTestEmail(t *testing.T) string {
	t.Helper()
	seq := testSeqCounter.Add(1)
	name := strings.ReplaceAll(t.Name(), "/", "-")
	if len(name) > 40 {
		name = name[:40]
	}
	return fmt.Sprintf("t-%s-%d@test.example.com", strings.ToLower(name), seq)
}

// uniqueTestRepoName generates a unique repository name scoped to the calling test.
func uniqueTestRepoName(t *testing.T) string {
	t.Helper()
	seq := testSeqCounter.Add(1)
	name := strings.ReplaceAll(t.Name(), "/", "-")
	if len(name) > 40 {
		name = name[:40]
	}
	return fmt.Sprintf("r-%s-%d", strings.ToLower(name), seq)
}

// TestMustCreateRepo_FailsWithoutParentUser verifies that repository inserts
// cannot name a missing parent user. The provisioning authorization trigger
// now rejects that invalid owner identity before the FK check itself runs.
func TestMustCreateRepo_FailsWithoutParentUser(t *testing.T) {
	_, pool := newQueries(t)

	// Use a user ID that was never inserted.
	const invalidUserID int64 = 999999

	lowerName := strings.ToLower("orphan-repo")
	var id int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (user_id, name, lower_name, description, storage_set_id, is_public, default_bookmark, next_issue_number) VALUES ($1, $2, $3, '', 's1', TRUE, 'main', 1) RETURNING id`,
		invalidUserID,
		"orphan-repo",
		lowerName,
	).Scan(&id)

	require.Error(t, err, "creating a repo without a valid parent user should fail")
	errMsg := strings.ToLower(err.Error())
	assert.Contains(t, errMsg, "owner identity does not match")
}

// mustExpectError runs fn inside a savepoint so that any PostgreSQL error
// (e.g. unique-constraint violation) is rolled back without poisoning the
// outer transaction. It asserts that fn returned a non-nil error and returns
// that error so callers can make further assertions (e.g. ErrorIs).
func mustExpectError(t *testing.T, db DBTX, fn func(sp DBTX) error) error {
	t.Helper()
	tx := db.(pgx.Tx)
	sp, err := tx.Begin(context.Background())
	require.NoError(t, err, "failed to create savepoint")
	fnErr := fn(sp)
	if fnErr != nil {
		_ = sp.Rollback(context.Background())
	} else {
		_ = sp.Commit(context.Background())
	}
	require.Error(t, fnErr, "expected an error from the savepoint operation")
	return fnErr
}

// mustExpectQueryError is like mustExpectError but provides a *Queries backed
// by the savepoint transaction so callers can use sqlc-generated methods.
func mustExpectQueryError(t *testing.T, db DBTX, fn func(spQ *Queries) error) error {
	t.Helper()
	return mustExpectError(t, db, func(sp DBTX) error {
		return fn(New(sp))
	})
}
