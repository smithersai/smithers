package product

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/database"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Set SMITHERS_PRODUCT_TEST_DATABASE_URL to a PostgreSQL URL whose user can
// create databases. The test creates and drops its own database.
func TestApplyFreshProductDatabase(t *testing.T) {
	raw := os.Getenv("SMITHERS_PRODUCT_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("set SMITHERS_PRODUCT_TEST_DATABASE_URL for PostgreSQL integration test")
	}
	ctx := context.Background()
	adminURL, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	adminURL.Path = "/postgres"
	admin, err := pgx.Connect(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	name := "smithers_product_" + hex.EncodeToString(random[:])
	if _, err := admin.Exec(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := admin.Exec(ctx, `DROP DATABASE "`+name+`" WITH (FORCE)`); err != nil {
			t.Errorf("drop test database: %v", err)
		}
	}()
	dbURL := *adminURL
	dbURL.Path = "/" + name
	poolConfig, err := pgxpool.ParseConfig(dbURL.String())
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.AfterConnect = func(_ context.Context, conn *pgx.Conn) error {
		database.ConfigureSQLCTypes(conn.TypeMap())
		return nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if applied, err := Status(ctx, pool); err != nil || applied {
		t.Fatalf("fresh database status: applied=%v err=%v", applied, err)
	}

	if err := Apply(ctx, pool); err != nil {
		t.Fatalf("fresh product migration: %v", err)
	}
	if applied, err := Status(ctx, pool); err != nil || !applied {
		t.Fatalf("migrated database status: applied=%v err=%v", applied, err)
	}
	if err := Apply(ctx, pool); err != nil {
		t.Fatalf("idempotent product migration: %v", err)
	}
	var infraMissing, placementColumnMissing bool
	if err := pool.QueryRow(ctx, `SELECT to_regclass('public.repo_storage_sets') IS NULL,
		NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
		AND table_name='repositories' AND column_name='storage_set_id')`).Scan(&infraMissing, &placementColumnMissing); err != nil {
		t.Fatal(err)
	}
	if !infraMissing || !placementColumnMissing {
		t.Fatal("product schema retained cluster storage placement")
	}

	var alice, bob, repo int64
	if err := pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('alice', 'alice') RETURNING id`).Scan(&alice); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('bob', 'bob') RETURNING id`).Scan(&bob); err != nil {
		t.Fatal(err)
	}
	var importJobID string
	var defaultBookmark string
	var publishReady bool
	if err := pool.QueryRow(ctx, `INSERT INTO import_jobs(user_id, github_owner, github_repo)
		VALUES ($1, 'alice', 'project') RETURNING id, default_bookmark, publish_ready`, alice).
		Scan(&importJobID, &defaultBookmark, &publishReady); err != nil {
		t.Fatal(err)
	}
	if defaultBookmark != "" || publishReady {
		t.Fatal("new import reservation unexpectedly marked ready")
	}
	if err := pool.QueryRow(ctx, `UPDATE import_jobs SET default_bookmark='trunk', publish_ready=true
		WHERE id=$1 RETURNING default_bookmark, publish_ready`, importJobID).
		Scan(&defaultBookmark, &publishReady); err != nil {
		t.Fatal(err)
	}
	if defaultBookmark != "trunk" || !publishReady {
		t.Fatal("import publication state was not durable")
	}
	queries := db.New(pool)
	repository, err := queries.CreateRepo(ctx, db.CreateRepoParams{
		UserID: pgtype.Int8{Int64: alice, Valid: true}, Name: "secret", LowerName: "secret", DefaultBookmark: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	repo = repository.ID
	if got, err := queries.GetRepoByID(ctx, repo); err != nil || got.ID != repo {
		t.Fatalf("generated repository read: id=%d err=%v", got.ID, err)
	}
	var ownerCanRead, outsiderCanRead bool
	if err := pool.QueryRow(ctx, `SELECT can_view_repository($1, $2), can_view_repository($1, $3)`, repo, alice, bob).Scan(&ownerCanRead, &outsiderCanRead); err != nil {
		t.Fatal(err)
	}
	if !ownerCanRead || outsiderCanRead {
		t.Fatal("private repository authorization crossed owners")
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	inside := queries.WithTx(tx)
	if _, err := inside.CreateIssue(ctx, db.CreateIssueParams{RepositoryID: repo, Title: "issue", AuthorID: alice}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if _, err := inside.CreateWikiPage(ctx, db.CreateWikiPageParams{RepositoryID: repo, Slug: "home", Title: "Home", AuthorID: alice}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if _, err := inside.CreateLandingRequest(ctx, db.CreateLandingRequestParams{RepositoryID: repo, Title: "review", AuthorID: alice, TargetBookmark: "main"}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"issues", "wiki_pages", "landing_requests"} {
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.`+table+` WHERE repository_id=$1`, repo).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Errorf("%s survived transaction rollback", table)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE smithers_product_migrations SET checksum='changed' WHERE version=$1`, BaselineVersion); err != nil {
		t.Fatal(err)
	}
	if err := Apply(ctx, pool); !errors.Is(err, ErrChecksumMismatch) {
		t.Fatalf("changed baseline should be rejected, got %v", err)
	}
	if applied, err := Status(ctx, pool); applied || !errors.Is(err, ErrChecksumMismatch) {
		t.Fatalf("changed baseline status: applied=%v err=%v", applied, err)
	}
	registered, err := registeredMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE smithers_product_migrations SET checksum=$1 WHERE version=$2`, registered[0].checksum, BaselineVersion); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO smithers_product_migrations(version, checksum) VALUES ($1, 'future')`, len(registered)+1); err != nil {
		t.Fatal(err)
	}
	if err := Apply(ctx, pool); !errors.Is(err, ErrUnsupportedVersion) {
		t.Fatalf("newer database should be rejected, got %v", err)
	}
}

func TestBaselineHasNoClusterTableNames(t *testing.T) {
	baseline, err := migrations.ReadFile("migrations/0001_product_baseline.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"repo_storage_sets", "repo_storage_nodes", "sandbox_hosts", "sandbox_instances", "runner_pool", "_sync_queue"} {
		if strings.Contains(string(baseline), name) {
			t.Errorf("product baseline still references %s", name)
		}
	}
}
