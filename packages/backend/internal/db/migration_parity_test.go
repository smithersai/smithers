package db

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestMigrationsParity verifies that applying all migration files in order
// produces the same public schema as db/schema.sql.
//
// This is the schema contract test: if it fails, either a new migration is
// needed for a change made in schema.sql, or schema.sql is missing a change
// that was made by a migration.
func TestMigrationsParity(t *testing.T) {
	databaseURL := resolveDBTestDatabaseURL(os.Getenv)

	parsed, err := url.Parse(databaseURL)
	require.NoError(t, err, "invalid database URL")

	// Use a separate database so we don't disturb the shared schema pool.
	origDB := strings.TrimPrefix(parsed.Path, "/")
	migrationDBName := origDB + "_migration_parity"

	adminURL := *parsed
	adminURL.Path = "/postgres"
	adminConn, err := pgx.Connect(context.Background(), adminURL.String())
	require.NoError(t, err, "cannot connect to postgres to create parity db")
	defer adminConn.Close(context.Background())

	// Drop+recreate to start clean.
	safeDBName := strings.ReplaceAll(migrationDBName, `"`, `""`)
	_, _ = adminConn.Exec(context.Background(), fmt.Sprintf(`DROP DATABASE IF EXISTS "%s"`, safeDBName))
	_, err = adminConn.Exec(context.Background(), fmt.Sprintf(`CREATE DATABASE "%s"`, safeDBName))
	require.NoError(t, err, "cannot create migration parity database")

	t.Cleanup(func() {
		dropConn, connErr := pgx.Connect(context.Background(), adminURL.String())
		if connErr == nil {
			_, _ = dropConn.Exec(context.Background(), fmt.Sprintf(`DROP DATABASE IF EXISTS "%s"`, safeDBName))
			dropConn.Close(context.Background())
		}
	})

	// Connect to the fresh parity DB.
	parityURL := *parsed
	parityURL.Path = "/" + migrationDBName
	parityConn, err := pgx.Connect(context.Background(), parityURL.String())
	require.NoError(t, err, "cannot connect to migration parity database")
	defer parityConn.Close(context.Background())

	// Enable pgcrypto (required by schema).
	_, err = parityConn.Exec(context.Background(), `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`)
	require.NoError(t, err, "cannot create pgcrypto extension")

	// Locate and sort migration files.
	migrationsDir := findMigrationsDir(t)
	entries, err := os.ReadDir(migrationsDir)
	require.NoError(t, err, "cannot read migrations directory")

	var migFiles []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		// Only apply numbered SQL migration files (skip atlas.hcl, atlas.sum, etc.)
		if !strings.HasSuffix(name, ".sql") {
			continue
		}
		migFiles = append(migFiles, filepath.Join(migrationsDir, name))
	}
	sort.Strings(migFiles)

	// Apply each migration in order.
	for _, mf := range migFiles {
		sql, readErr := os.ReadFile(mf)
		require.NoErrorf(t, readErr, "cannot read migration file %s", mf)
		execErr := execParityMigration(context.Background(), parityConn, string(sql))
		require.NoErrorf(t, execErr, "migration %s failed", filepath.Base(mf))
	}

	// Collect tables from the migration-built database.
	migrationTables := publicTableNames(t, parityConn)

	// Collect tables from the schema.sql-built database (the shared test DB).
	schemaTables := publicTableNames(t, sharedPool)

	// Compare: every table in schema.sql must exist after migrations.
	missingFromMigrations := subtract(schemaTables, migrationTables)
	assert.Empty(t, missingFromMigrations,
		"tables present in schema.sql but absent after applying all migrations (add a migration for each): %v",
		missingFromMigrations)

	// Compare: every table produced by migrations must exist in schema.sql.
	// This catches migrations that create tables no longer in schema.sql
	// (forgotten DROP TABLE migrations or stale migration content).
	extraFromMigrations := subtract(migrationTables, schemaTables)
	assert.Empty(t, extraFromMigrations,
		"tables created by migrations but absent from schema.sql (add them to schema.sql or add a DROP TABLE migration): %v",
		extraFromMigrations)

	assertCatalogEqual(t, "columns", publicColumns(t, sharedPool), publicColumns(t, parityConn))
	assertCatalogEqual(t, "indexes", publicIndexes(t, sharedPool), publicIndexes(t, parityConn))
	assertCatalogEqual(t, "constraints", publicConstraints(t, sharedPool), publicConstraints(t, parityConn))
	// Denormalized counters (num_stars, comment_count, ...), reaction cleanup
	// and the webhook/workspace caps live only in triggers; no query writes
	// them. A migration chain without the triggers ships frozen counters.
	assertCatalogEqual(t, "triggers", publicTriggers(t, sharedPool), publicTriggers(t, parityConn))
	assertCatalogEqual(t, "functions", publicFunctions(t, sharedPool), publicFunctions(t, parityConn))

	// Table-name parity alone cannot see a CHECK constraint that only
	// db/schema.sql widened. The workflow lifecycle status columns are the ones
	// that bite: dispatch writes every state below, so a migration chain that
	// still rejects one makes those workflows undispatchable in production
	// while every schema.sql-built dev/test database stays green.
	assertMigrationBuiltStatusesAccepted(t, parityConn, "workflow_tasks",
		"(workflow_run_id, workflow_step_id, repository_id, status, payload) VALUES (1, 1, 1, $1, '{}'::jsonb)",
		[]string{"pending", "assigned", "running", "done", "failed", "cancelled", "blocked", "skipped"})
	assertMigrationBuiltStatusesAccepted(t, parityConn, "workflow_steps",
		"(workflow_run_id, repository_id, name, position, status) VALUES (1, 1, 'probe', 1, $1)",
		[]string{"queued", "running", "success", "failure", "skipped", "cancelled"})
	assertMigrationBuiltNullableUserIdentities(t, parityConn)

	var storageSetFKValidated bool
	var storageSetFKDeleteAction string
	require.NoError(t, parityConn.QueryRow(context.Background(), `
		SELECT constraint_row.convalidated, constraint_row.confdeltype::text
		FROM pg_constraint AS constraint_row
		WHERE constraint_row.conrelid = 'repositories'::regclass
		  AND constraint_row.conname = 'fk_repositories_storage_set'
	`).Scan(&storageSetFKValidated, &storageSetFKDeleteAction))
	assert.True(t, storageSetFKValidated, "migration-built repository storage-set FK must be validated")
	assert.Equal(t, "r", storageSetFKDeleteAction, "repository storage-set deletion must be restricted")
}

// assertMigrationBuiltNullableUserIdentities protects the user-deletion and
// agent-activity contract that db/schema.sql already exposes through sqlc. A
// migration-built production database must accept identity-less audit rows,
// preserve rows when a referenced user is deleted, and enforce collaborator
// uniqueness only for live users.
func assertMigrationBuiltNullableUserIdentities(t *testing.T, conn *pgx.Conn) {
	t.Helper()
	ctx := context.Background()

	columns := []struct {
		table  string
		column string
	}{
		{table: "collaborators", column: "user_id"},
		{table: "issue_comments", column: "user_id"},
		{table: "landing_request_comments", column: "user_id"},
		{table: "landing_request_reviews", column: "reviewer_id"},
	}
	for _, column := range columns {
		var nullable string
		err := conn.QueryRow(ctx, `
			SELECT is_nullable
			FROM information_schema.columns
			WHERE table_schema = 'public'
			  AND table_name = $1
			  AND column_name = $2
		`, column.table, column.column).Scan(&nullable)
		require.NoErrorf(t, err, "cannot inspect %s.%s", column.table, column.column)
		assert.Equalf(t, "YES", nullable, "%s.%s must accept NULL identities", column.table, column.column)
	}

	foreignKeys := []struct {
		table      string
		constraint string
	}{
		{table: "collaborators", constraint: "collaborators_user_id_fkey"},
		{table: "issue_comments", constraint: "issue_comments_user_id_fkey"},
		{table: "landing_request_comments", constraint: "landing_request_comments_user_id_fkey"},
		{table: "landing_request_reviews", constraint: "landing_request_reviews_reviewer_id_fkey"},
	}
	for _, foreignKey := range foreignKeys {
		var deleteAction string
		err := conn.QueryRow(ctx, `
			SELECT constraint_row.confdeltype::text
			FROM pg_constraint AS constraint_row
			WHERE constraint_row.conrelid = $1::regclass
			  AND constraint_row.conname = $2
		`, foreignKey.table, foreignKey.constraint).Scan(&deleteAction)
		require.NoErrorf(t, err, "cannot inspect %s", foreignKey.constraint)
		assert.Equalf(t, "n", deleteAction, "%s must use ON DELETE SET NULL", foreignKey.constraint)
	}

	var collaboratorIndex string
	err := conn.QueryRow(ctx, `
		SELECT indexdef
		FROM pg_indexes
		WHERE schemaname = 'public'
		  AND tablename = 'collaborators'
		  AND indexname = 'uq_collaborators_repo_user'
	`).Scan(&collaboratorIndex)
	require.NoError(t, err, "cannot inspect active-collaborator unique index")
	assert.Contains(t, collaboratorIndex, "UNIQUE INDEX")
	assert.Contains(t, collaboratorIndex, "(repository_id, user_id)")
	assert.Contains(t, collaboratorIndex, "WHERE (user_id IS NOT NULL)")
}

// assertMigrationBuiltStatusesAccepted proves the migration-built schema
// accepts every status value the Go code writes for a table, by letting
// Postgres itself evaluate the constraints rather than string-matching
// pg_get_constraintdef.
//
// The probe clones the real table's defaults and CHECK constraints into a temp
// table. CREATE TABLE ... LIKE copies neither foreign keys nor triggers, so
// placeholder parent ids suffice and the CHECK constraints are still the ones
// under test.
func assertMigrationBuiltStatusesAccepted(t *testing.T, conn *pgx.Conn, table, insertSuffix string, statuses []string) {
	t.Helper()
	ctx := context.Background()
	probe := table + "_status_probe"

	_, err := conn.Exec(ctx, fmt.Sprintf(
		`CREATE TEMP TABLE %s (LIKE %s INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`, probe, table))
	require.NoErrorf(t, err, "cannot clone %s for status probing", table)
	t.Cleanup(func() {
		_, _ = conn.Exec(context.Background(), fmt.Sprintf(`DROP TABLE IF EXISTS %s`, probe))
	})

	for _, status := range statuses {
		_, err := conn.Exec(ctx, fmt.Sprintf(`INSERT INTO %s %s`, probe, insertSuffix), status)
		assert.NoErrorf(t, err,
			"migration-built %s rejects status %q that the application writes; "+
				"db/schema.sql accepts it, so a migration is missing", table, status)
	}
}

// execParityMigration mirrors Atlas' txmode handling. PostgreSQL treats a
// multi-statement simple query as one implicit transaction, which makes a
// valid `CREATE INDEX CONCURRENTLY` file fail in this test even though Atlas
// executes `-- atlas:txmode none` statements independently in production.
// Current non-transactional migrations contain only top-level DDL statements;
// dollar-quoted function bodies must remain in ordinary transactional files.
func execParityMigration(ctx context.Context, conn *pgx.Conn, sql string) error {
	if !hasAtlasTxModeNoneHeader(sql) {
		_, err := conn.Exec(ctx, sql)
		return err
	}
	for _, statement := range strings.Split(sql, ";") {
		if strings.TrimSpace(statement) == "" {
			continue
		}
		if _, err := conn.Exec(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

// hasAtlasTxModeNoneHeader follows Atlas' file-directive boundary: file-level
// directives must be in the first comment block and separated from ordinary
// migration comments/statements by a blank line. Keeping this parser strict
// prevents the parity test from accepting a directive that Atlas ignores.
func hasAtlasTxModeNoneHeader(sql string) bool {
	header, _, hasBoundary := strings.Cut(strings.ReplaceAll(sql, "\r\n", "\n"), "\n\n")
	if !hasBoundary {
		return false
	}
	for _, line := range strings.Split(header, "\n") {
		if strings.TrimSpace(line) == "-- atlas:txmode none" {
			return true
		}
	}
	return false
}

func TestAtlasTxModeNoneDirectiveRequiresAFileHeaderBoundary(t *testing.T) {
	t.Parallel()

	assert.True(t, hasAtlasTxModeNoneHeader("-- atlas:txmode none\n\nCREATE INDEX CONCURRENTLY idx ON t (id);"))
	assert.True(t, hasAtlasTxModeNoneHeader("-- atlas:txmode none\r\n\r\nCREATE INDEX CONCURRENTLY idx ON t (id);"))
	assert.False(t, hasAtlasTxModeNoneHeader("-- atlas:txmode none\n-- migration comment\nCREATE INDEX CONCURRENTLY idx ON t (id);"))
	assert.False(t, hasAtlasTxModeNoneHeader("-- migration comment\n\n-- atlas:txmode none\nCREATE INDEX CONCURRENTLY idx ON t (id);"))
}

func TestWorkflowTaskRepositoryInvariantExistsInMigrationHistory(t *testing.T) {
	migrationPath := filepath.Join(findMigrationsDir(t), "20260718000000_add_workflow_run_execution_plane.sql")
	contents, err := os.ReadFile(migrationPath)
	require.NoError(t, err)
	sql := string(contents)
	assert.Contains(t, sql, "CREATE OR REPLACE FUNCTION set_workflow_task_repository_id()")
	assert.Contains(t, sql, "CREATE TRIGGER trg_workflow_tasks_repository_id")
	assert.Contains(t, sql, "CREATE TRIGGER trg_workflow_runs_10_force_agent_plane")
	assert.Contains(t, sql, "CREATE TRIGGER trg_workflow_runs_20_execution_plane_immutable")
	assert.Contains(t, sql, "CREATE TRIGGER trg_workflow_runs_30_status_claim_guard")
	assert.Contains(t, sql, "CREATE TRIGGER trg_workflow_tasks_20_execution_plane_claim_guard")
}

func TestDeletionTokenStateConstraintsExistInMigrationHistoryAndSchema(t *testing.T) {
	migrationsDir := findMigrationsDir(t)
	cacheMigration, err := os.ReadFile(filepath.Join(migrationsDir, "20260718000300_add_workflow_cache_deleting_status.sql"))
	require.NoError(t, err)
	artifactMigration, err := os.ReadFile(filepath.Join(migrationsDir, "20260718000400_add_artifact_deletion_claims.sql"))
	require.NoError(t, err)
	schema, err := os.ReadFile(findSchemaPath())
	require.NoError(t, err)

	for _, constraint := range []string{
		"workflow_caches_deletion_state_check",
		"workflow_artifacts_deletion_state_check",
		"issue_artifacts_deletion_state_check",
	} {
		assert.Contains(t, string(schema), constraint)
	}
	assert.Contains(t, string(cacheMigration), "workflow_caches_deletion_state_check")
	assert.Contains(t, string(artifactMigration), "workflow_artifacts_deletion_state_check")
	assert.Contains(t, string(artifactMigration), "issue_artifacts_deletion_state_check")
	assert.Contains(t, string(cacheMigration), "smithers:migration-contract-reviewed: release owner @williamcory, ticket PLUE-REVIEW-83")
	assert.Equal(t, 2, strings.Count(string(artifactMigration), "smithers:migration-contract-reviewed: release owner @williamcory, ticket PLUE-REVIEW-84"))
}

func TestRolloutMutationFencesExpandBeforeTheyContract(t *testing.T) {
	migrationsDir := findMigrationsDir(t)
	storageMigration, err := os.ReadFile(filepath.Join(migrationsDir, "20260718000700_add_repository_storage_operations.sql"))
	require.NoError(t, err)
	provisioningMigration, err := os.ReadFile(filepath.Join(migrationsDir, "20260718000900_add_repository_provisioning_operations.sql"))
	require.NoError(t, err)
	contractMigration, err := os.ReadFile(filepath.Join(migrationsDir, "20260718001700_rollout_mutation_fences.sql"))
	require.NoError(t, err)

	storageSQL := string(storageMigration)
	controlOffset := strings.Index(storageSQL, "CREATE TABLE legacy_mutation_fence_control")
	triggerOffset := strings.Index(storageSQL, "CREATE TRIGGER trg_repositories_fence_storage_operation")
	require.NotEqual(t, -1, controlOffset)
	require.NotEqual(t, -1, triggerOffset)
	assert.Less(t, controlOffset, triggerOffset,
		"the compatibility switch must commit in the same migration before the repository trigger becomes visible")
	assert.Contains(t, storageSQL, "enforce_repository_storage BOOLEAN NOT NULL DEFAULT FALSE")
	assert.Contains(t, storageSQL, "IF NOT v_has_operation AND NOT v_enforce_repository_storage THEN")
	assert.Contains(t, string(provisioningMigration), "v_enforce_repository_storage")
	assert.Contains(t, string(provisioningMigration), "AND EXISTS (SELECT 1 FROM repositories")

	contractSQL := string(contractMigration)
	assert.Contains(t, contractSQL, "ADD COLUMN enforce_release_deletion BOOLEAN NOT NULL DEFAULT FALSE")
	assert.Contains(t, contractSQL, "CREATE OR REPLACE FUNCTION guard_artifact_deletion_claim()")
}

func TestWorkflowLogBudgetCountersExistInMigrationHistoryAndSchema(t *testing.T) {
	migration, err := os.ReadFile(filepath.Join(findMigrationsDir(t), "20260718000800_add_workflow_log_budgets.sql"))
	require.NoError(t, err)
	schema, err := os.ReadFile(findSchemaPath())
	require.NoError(t, err)

	for _, expected := range []string{
		"workflow_runs_log_bytes_nonnegative",
		"workflow_runs_log_entry_count_nonnegative",
		"workflow_log_budget_initializations",
		"CREATE OR REPLACE FUNCTION initialize_new_workflow_log_budget()",
		"CREATE OR REPLACE FUNCTION backfill_one_workflow_log_budget()",
		"FOR UPDATE OF run SKIP LOCKED",
		"LIMIT 1",
		"CREATE OR REPLACE FUNCTION reserve_workflow_log_budget()",
		"CREATE TRIGGER trg_workflow_logs_reserve_budget",
		"CREATE TRIGGER trg_workflow_run_logs_reserve_budget",
		"ERRCODE = '54000'",
		"workflow_run_log_budget",
		"100000::bigint",
		"52428800::bigint",
	} {
		assert.Contains(t, string(migration), expected)
		assert.Contains(t, string(schema), expected)
	}
	assert.NotContains(t, string(migration), "WITH totals AS (",
		"the schema migration must not aggregate every historical log row while holding DDL locks")
}

func TestRepositoryStorageSetForeignKeyMigrationIsRollingSafe(t *testing.T) {
	migration, err := os.ReadFile(filepath.Join(findMigrationsDir(t), "20260718002200_add_repositories_storage_set_fk.sql"))
	require.NoError(t, err)
	sql := string(migration)
	assert.Contains(t, sql, "LEFT JOIN repo_storage_sets")
	assert.Contains(t, sql, "unknown storage_set_id sample")
	assert.Contains(t, sql, "ADD CONSTRAINT fk_repositories_storage_set")
	assert.Contains(t, sql, "ON DELETE RESTRICT")
	assert.Contains(t, sql, "NOT VALID")
	assert.Contains(t, sql, "VALIDATE CONSTRAINT fk_repositories_storage_set")

	schema, err := os.ReadFile(findSchemaPath())
	require.NoError(t, err)
	assert.Contains(t, string(schema), "CONSTRAINT fk_repositories_storage_set")
}

func TestLegacyFinalKeyCapabilityMigrationFailsClosed(t *testing.T) {
	migration, err := os.ReadFile(filepath.Join(findMigrationsDir(t), "20260718002100_fence_legacy_final_key_capabilities.sql"))
	require.NoError(t, err)
	query, err := os.ReadFile(filepath.Join(findMigrationsDir(t), "..", "queries", "storage_deletion_queue.sql"))
	require.NoError(t, err)
	schema, err := os.ReadFile(findSchemaPath())
	require.NoError(t, err)

	for _, expected := range []string{
		"storage_legacy_capability_horizons",
		"'legacy-final-key-upload', 'infinity'::timestamptz",
		"requested_delete_after",
		"is_storage_staging_deletion_key",
		"GREATEST(v_requested_delete_after, v_horizon)",
		"legacy capability horizon can only be extended",
	} {
		assert.Contains(t, string(migration), expected)
		assert.Contains(t, string(schema), expected)
	}
	assert.NotContains(t, string(migration), "INTERVAL '7 days",
		"legacy final-key safety cannot assume the current V4 capability ceiling")
	assert.Contains(t, string(query), "IsLegacyFinalKeyPurgeAllowed")
	assert.Contains(t, string(query), "clock_timestamp()")
	assert.Contains(t, string(query), "COALESCE(requested_delete_after, delete_after) <= NOW()")
}

// publicTableNames returns sorted table names from the public schema.
func publicTableNames(t *testing.T, db DBTX) []string {
	t.Helper()
	rows, err := db.Query(context.Background(),
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
		 ORDER BY table_name`)
	require.NoError(t, err, "cannot query table names")
	defer rows.Close()

	var names []string
	for rows.Next() {
		var name string
		require.NoError(t, rows.Scan(&name))
		names = append(names, name)
	}
	require.NoError(t, rows.Err())
	return names
}

type catalogColumn struct {
	Table      string
	Name       string
	DataType   string
	Nullable   bool
	DefaultSQL string
}

// publicColumns returns a normalized information_schema.columns dump. The
// information_schema type fields are kept separate instead of relying on
// data_type alone, which would miss drift such as varchar(255) vs varchar(64).
func publicColumns(t *testing.T, db DBTX) []catalogColumn {
	t.Helper()
	rows, err := db.Query(context.Background(), `
		SELECT table_name,
		       column_name,
		       concat_ws(':', data_type, udt_schema, udt_name,
		           character_maximum_length::text,
		           numeric_precision::text,
		           numeric_scale::text,
		           datetime_precision::text) AS normalized_type,
		       is_nullable = 'YES',
		       COALESCE(column_default, '')
		FROM information_schema.columns
		WHERE table_schema = 'public'
		ORDER BY table_name, ordinal_position`)
	require.NoError(t, err, "cannot query public columns")
	defer rows.Close()

	var columns []catalogColumn
	for rows.Next() {
		var column catalogColumn
		require.NoError(t, rows.Scan(
			&column.Table,
			&column.Name,
			&column.DataType,
			&column.Nullable,
			&column.DefaultSQL,
		))
		column.DefaultSQL = normalizeCatalogSQL(column.DefaultSQL)
		columns = append(columns, column)
	}
	require.NoError(t, rows.Err())
	return columns
}

type catalogIndex struct {
	Table      string
	Name       string
	Definition string
}

func publicIndexes(t *testing.T, db DBTX) []catalogIndex {
	t.Helper()
	rows, err := db.Query(context.Background(), `
		SELECT tablename, indexname, indexdef
		FROM pg_indexes
		WHERE schemaname = 'public'
		ORDER BY tablename, indexname`)
	require.NoError(t, err, "cannot query public indexes")
	defer rows.Close()

	var indexes []catalogIndex
	for rows.Next() {
		var index catalogIndex
		require.NoError(t, rows.Scan(&index.Table, &index.Name, &index.Definition))
		index.Definition = normalizeCatalogSQL(index.Definition)
		indexes = append(indexes, index)
	}
	require.NoError(t, rows.Err())
	return indexes
}

type catalogConstraint struct {
	Table      string
	Name       string
	Type       string
	Definition string
	Deferrable bool
	Deferred   bool
	Validated  bool
}

func publicConstraints(t *testing.T, db DBTX) []catalogConstraint {
	t.Helper()
	rows, err := db.Query(context.Background(), `
		SELECT table_row.relname,
		       constraint_row.conname,
		       constraint_row.contype::text,
		       pg_get_constraintdef(constraint_row.oid, true),
		       constraint_row.condeferrable,
		       constraint_row.condeferred,
		       constraint_row.convalidated
		FROM pg_constraint AS constraint_row
		JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
		JOIN pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
		WHERE schema_row.nspname = 'public'
		  AND table_row.relkind IN ('r', 'p')
		  -- PostgreSQL 18 also exposes NOT NULL constraints here. Column
		  -- nullability is compared above; their generated names are not a
		  -- separate schema contract.
		  AND constraint_row.contype <> 'n'
		ORDER BY table_row.relname, constraint_row.conname`)
	require.NoError(t, err, "cannot query public constraints")
	defer rows.Close()

	var constraints []catalogConstraint
	for rows.Next() {
		var constraint catalogConstraint
		require.NoError(t, rows.Scan(
			&constraint.Table,
			&constraint.Name,
			&constraint.Type,
			&constraint.Definition,
			&constraint.Deferrable,
			&constraint.Deferred,
			&constraint.Validated,
		))
		constraint.Definition = normalizeCatalogSQL(constraint.Definition)
		constraints = append(constraints, constraint)
	}
	require.NoError(t, rows.Err())
	return constraints
}

type catalogTrigger struct {
	Table      string
	Name       string
	Definition string
}

func publicTriggers(t *testing.T, db DBTX) []catalogTrigger {
	t.Helper()
	rows, err := db.Query(context.Background(), `
		SELECT table_row.relname, trigger_row.tgname, pg_get_triggerdef(trigger_row.oid, true)
		FROM pg_trigger AS trigger_row
		JOIN pg_class AS table_row ON table_row.oid = trigger_row.tgrelid
		JOIN pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
		WHERE schema_row.nspname = 'public'
		  AND NOT trigger_row.tgisinternal
		  AND trigger_row.tgname NOT LIKE '%test\_%'
		ORDER BY table_row.relname, trigger_row.tgname`)
	require.NoError(t, err, "cannot query public triggers")
	defer rows.Close()

	var triggers []catalogTrigger
	for rows.Next() {
		var trigger catalogTrigger
		require.NoError(t, rows.Scan(&trigger.Table, &trigger.Name, &trigger.Definition))
		trigger.Definition = normalizeCatalogSQL(trigger.Definition)
		triggers = append(triggers, trigger)
	}
	require.NoError(t, rows.Err())
	return triggers
}

type catalogFunction struct {
	Name      string
	Arguments string
	Returns   string
}

// publicFunctions compares signatures only. Several migration-built function
// bodies differ from db/schema.sql by formatting, so body parity is a
// separate contract. The shared test DB also carries the test_* fixture from
// repositoryInsertFixtureTriggerSQL, which is not part of db/schema.sql.
func publicFunctions(t *testing.T, db DBTX) []catalogFunction {
	t.Helper()
	rows, err := db.Query(context.Background(), `
		SELECT function_row.proname,
		       pg_get_function_identity_arguments(function_row.oid),
		       pg_get_function_result(function_row.oid)
		FROM pg_proc AS function_row
		JOIN pg_namespace AS schema_row ON schema_row.oid = function_row.pronamespace
		WHERE schema_row.nspname = 'public'
		  AND function_row.prokind = 'f'
		  AND function_row.proname NOT LIKE 'test\_%'
		  AND NOT EXISTS (
		      SELECT 1 FROM pg_depend AS dependency_row
		      WHERE dependency_row.objid = function_row.oid
		        AND dependency_row.deptype = 'e')
		ORDER BY function_row.proname, 2`)
	require.NoError(t, err, "cannot query public functions")
	defer rows.Close()

	var functions []catalogFunction
	for rows.Next() {
		var function catalogFunction
		require.NoError(t, rows.Scan(&function.Name, &function.Arguments, &function.Returns))
		functions = append(functions, function)
	}
	require.NoError(t, rows.Err())
	return functions
}

func normalizeCatalogSQL(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func TestNormalizeCatalogSQL(t *testing.T) {
	t.Parallel()
	assert.Equal(t, "CREATE INDEX idx ON public.widgets USING btree (id)",
		normalizeCatalogSQL("CREATE  INDEX idx\n  ON public.widgets USING btree (id)"))
}

func assertCatalogEqual[T comparable](t *testing.T, catalog string, expected, actual []T) {
	t.Helper()
	missing := subtractComparable(expected, actual)
	extra := subtractComparable(actual, expected)
	assert.Empty(t, missing,
		"%s present in db/schema.sql but absent after applying all migrations", catalog)
	assert.Empty(t, extra,
		"%s produced by migrations but absent from db/schema.sql", catalog)
}

func subtractComparable[T comparable](a, b []T) []T {
	set := make(map[T]struct{}, len(b))
	for _, value := range b {
		set[value] = struct{}{}
	}
	var diff []T
	for _, value := range a {
		if _, ok := set[value]; !ok {
			diff = append(diff, value)
		}
	}
	return diff
}

// subtract returns elements in a that are not in b.
func subtract(a, b []string) []string {
	set := make(map[string]struct{}, len(b))
	for _, v := range b {
		set[v] = struct{}{}
	}
	var diff []string
	for _, v := range a {
		if _, ok := set[v]; !ok {
			diff = append(diff, v)
		}
	}
	return diff
}

func findMigrationsDir(t *testing.T) string {
	t.Helper()
	candidates := []string{
		filepath.Join("..", "..", "db", "migrations"),
		filepath.Join("db", "migrations"),
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			abs, err := filepath.Abs(p)
			require.NoError(t, err)
			return abs
		}
	}
	t.Fatalf("could not locate db/migrations from cwd")
	return ""
}
