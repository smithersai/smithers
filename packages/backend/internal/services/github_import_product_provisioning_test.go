package services

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
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/database"
)

func TestProductImportReservationSurvivesRestartAndPublishesOnce(t *testing.T) {
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
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	name := "smithers_import_" + hex.EncodeToString(suffix[:])
	if _, err := admin.Exec(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(context.Background(), `DROP DATABASE "`+name+`" WITH (FORCE)`); err != nil {
			t.Errorf("drop product import test database: %v", err)
		}
		_ = admin.Close(context.Background())
	})
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
	if err := product.Apply(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var userID int64
	if err := pool.QueryRow(ctx, `INSERT INTO users(username, lower_username)
		VALUES ('alice', 'alice') RETURNING id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	const claimToken = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const provisionToken = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	var jobID string
	if err := pool.QueryRow(ctx, `INSERT INTO import_jobs
		(user_id, github_owner, github_repo, repo_owner, repo_name, branch, claim_token, claimed_at)
		VALUES ($1, 'upstream', 'project', 'alice', 'project', 'main', $2, NOW()) RETURNING id`,
		userID, claimToken).Scan(&jobID); err != nil {
		t.Fatal(err)
	}
	wanted := repositoryProvisioningOperation{
		OperationType: repositoryProvisionImport, Token: provisionToken,
		ActorID: userID, StorageSetID: DefaultStorageSetID,
		OwnerName: "alice", UserID: pgtype.Int8{Int64: userID, Valid: true},
		Name: "project", LowerName: "project", Description: "Imported from github.com/upstream/project",
		DefaultBookmark: "main", ImportJobID: jobID, ImportJobClaimToken: claimToken,
	}
	store := &productImportProvisioningStore{pool: pool}
	reserved, err := store.Reserve(ctx, wanted)
	if err != nil || reserved.RepositoryID == 0 {
		t.Fatalf("reserve product import: id=%d err=%v", reserved.RepositoryID, err)
	}
	// A new store instance simulates recovery after the process lost its reply.
	reopened := &productImportProvisioningStore{pool: pool}
	loaded, err := reopened.GetByToken(ctx, provisionToken)
	if err != nil || loaded.RepositoryID != reserved.RepositoryID || loaded.PublishReady {
		t.Fatalf("recover product import: %+v err=%v", loaded, err)
	}
	if err := reopened.AcquireProcessing(ctx, loaded.RepositoryID, provisionToken, claimToken); err != nil {
		t.Fatal(err)
	}
	if err := reopened.MarkPublishReady(ctx, loaded.RepositoryID, provisionToken, claimToken); err != nil {
		t.Fatal(err)
	}
	loaded, err = reopened.GetByToken(ctx, provisionToken)
	if err != nil || !loaded.PublishReady || loaded.DefaultBookmark != "main" {
		t.Fatalf("recover sealed mirror: %+v err=%v", loaded, err)
	}
	repository, err := reopened.Publish(ctx, loaded, claimToken)
	if err != nil {
		t.Fatal(err)
	}
	if repository.ID != reserved.RepositoryID || repository.Name != "project" || repository.IsPublic {
		t.Fatalf("published wrong repository: %+v", repository)
	}
	second, err := reopened.Publish(ctx, loaded, claimToken)
	if err != nil || second.ID != repository.ID {
		t.Fatalf("idempotent publication: %+v err=%v", second, err)
	}
	if err := reopened.Complete(ctx, repository.ID, provisionToken, claimToken); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE import_jobs SET status='ready' WHERE id=$1`, jobID); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.GetByToken(ctx, provisionToken); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("completed import remains claimable: %v", err)
	}
	const abortClaim = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	const abortToken = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	var abortJobID string
	if err := pool.QueryRow(ctx, `INSERT INTO import_jobs
		(user_id, github_owner, github_repo, repo_owner, repo_name, branch, claim_token, claimed_at)
		VALUES ($1, 'upstream', 'aborted', 'alice', 'aborted', 'main', $2, NOW()) RETURNING id`,
		userID, abortClaim).Scan(&abortJobID); err != nil {
		t.Fatal(err)
	}
	abortWanted := wanted
	abortWanted.Token = abortToken
	abortWanted.Name = "aborted"
	abortWanted.LowerName = "aborted"
	abortWanted.Description = "Imported from github.com/upstream/aborted"
	abortWanted.ImportJobID = abortJobID
	abortWanted.ImportJobClaimToken = abortClaim
	abortReserved, err := reopened.Reserve(ctx, abortWanted)
	if err != nil {
		t.Fatal(err)
	}
	physicalAbortCalled := false
	if err := reopened.Abort(ctx, abortReserved, abortClaim, func(context.Context) error {
		physicalAbortCalled = true
		return nil
	}); err != nil || !physicalAbortCalled {
		t.Fatalf("compensate unpublished import: called=%v err=%v", physicalAbortCalled, err)
	}
	if _, err := reopened.GetByToken(ctx, abortToken); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("aborted reservation remains bound: %v", err)
	}
	// The same job can reserve fresh storage after compensation; a stale URL
	// or token from the aborted stage cannot publish that new reservation.
	abortWanted.Token = strings.Repeat("e", 64)
	if _, err := reopened.Reserve(ctx, abortWanted); err != nil {
		t.Fatalf("retry import after compensation: %v", err)
	}
}
