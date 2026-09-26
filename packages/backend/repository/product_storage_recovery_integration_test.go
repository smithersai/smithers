package repository_test

import (
	"context"
	stdErrors "errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// The same product journal settles a delete, committed transfer, and rolled
// back transfer after the app and embedded jj service have both restarted.
func TestProductRepositoryStorageOperationsSurviveRestart(t *testing.T) {
	ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if ffi == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	pool, _ := postgresfixture.NewProductDatabase(t)
	alice := createProductProvisionUser(t, ctx, pool, "alice")
	bob := createProductProvisionUser(t, ctx, pool, "bob")
	storage := t.TempDir()
	local := openProductProvisionLocal(t, storage, ffi)
	defer func() { _ = local.Shutdown(context.Background()) }()
	service := services.NewProductRepoServiceWithPool(db.New(pool), local.Client(), pool)
	deleted, err := service.CreateRepo(ctx, &alice, "deleted", "", true, "main", true)
	if err != nil {
		t.Fatal(err)
	}
	committed, err := service.CreateRepo(ctx, &alice, "committed", "", true, "main", true)
	if err != nil {
		t.Fatal(err)
	}
	rolledBack, err := service.CreateRepo(ctx, &alice, "rolled-back", "", true, "main", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM repositories WHERE id=$1`, deleted.ID); err == nil {
		t.Fatal("direct repository deletion bypassed the durable storage journal")
	} else {
		requireStorageFence(t, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE repositories SET user_id=$2 WHERE id=$1`, committed.ID, bob.ID); err == nil {
		t.Fatal("direct repository transfer bypassed the durable storage journal")
	} else {
		requireStorageFence(t, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, alice.ID); err == nil {
		t.Fatal("owner deletion cascaded repository storage")
	} else {
		requireStorageFence(t, err)
	}

	deleteStage, err := local.Client().PrepareStagedDelete(ctx, alice.Username, deleted.Name)
	if err != nil || deleteStage.StorageRouteKey != "static" {
		t.Fatalf("prepare delete route: %+v, %v", deleteStage, err)
	}
	insertStorageRecoveryJob(t, ctx, pool, deleted.ID, "delete", deleteStage.Token, deleteStage.StorageRouteKey,
		alice.ID, alice.Username, deleted.Name, 0, "")
	if _, err := pool.Exec(ctx, `UPDATE repositories SET description='blocked' WHERE id=$1`, deleted.ID); err == nil {
		t.Fatal("metadata update bypassed an unresolved storage journal")
	} else {
		requireStorageFence(t, err)
	}
	if err := local.Client().ExecuteStagedDelete(ctx, deleteStage); err != nil {
		t.Fatal(err)
	}
	deleteTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := deleteTx.Exec(ctx, `SELECT set_config('smithers.repository_storage_operation_token',$1,true)`, deleteStage.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := deleteTx.Exec(ctx, `DELETE FROM repositories WHERE id=$1`, deleted.ID); err != nil {
		t.Fatal(err)
	}
	if err := deleteTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	committedStage, err := local.Client().PrepareStagedMove(ctx, alice.Username, committed.Name, bob.Username, committed.Name)
	if err != nil || committedStage.StorageRouteKey != "static" {
		t.Fatalf("prepare committed move route: %+v, %v", committedStage, err)
	}
	insertStorageRecoveryJob(t, ctx, pool, committed.ID, "move", committedStage.Token, committedStage.StorageRouteKey,
		alice.ID, alice.Username, committed.Name, bob.ID, bob.Username)
	if err := local.Client().ExecuteStagedMove(ctx, committedStage); err != nil {
		t.Fatal(err)
	}
	moveTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := moveTx.Exec(ctx, `SELECT set_config('smithers.repository_storage_operation_token',$1,true)`, committedStage.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := moveTx.Exec(ctx, `UPDATE repositories SET user_id=$2 WHERE id=$1`, committed.ID, bob.ID); err != nil {
		t.Fatal(err)
	}
	if err := moveTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	rollbackStage, err := local.Client().PrepareStagedMove(ctx, alice.Username, rolledBack.Name, bob.Username, rolledBack.Name)
	if err != nil || rollbackStage.StorageRouteKey != "static" {
		t.Fatalf("prepare rollback route: %+v, %v", rollbackStage, err)
	}
	insertStorageRecoveryJob(t, ctx, pool, rolledBack.ID, "move", rollbackStage.Token, rollbackStage.StorageRouteKey,
		alice.ID, alice.Username, rolledBack.Name, bob.ID, bob.Username)
	if err := local.Client().ExecuteStagedMove(ctx, rollbackStage); err != nil {
		t.Fatal(err)
	}
	// The PostgreSQL row remains at the source identity after a failed commit.
	if err := local.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	local = openProductProvisionLocal(t, storage, ffi)
	reconciler := services.NewRepositoryStorageOperationReconciler(pool, local.Client())
	recoveryCtx, stopRecovery := context.WithCancel(ctx)
	defer stopRecovery()
	go reconciler.Start(recoveryCtx)
	deadline := time.After(15 * time.Second)
	for {
		var pending int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM repository_storage_operations`).Scan(&pending); err != nil {
			t.Fatal(err)
		}
		if pending == 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("restart left %d storage operation receipts", pending)
		case <-time.After(100 * time.Millisecond):
		}
	}
	assertStoragePath := func(owner, name string, want bool) {
		t.Helper()
		_, err := os.Stat(filepath.Join(storage, owner, name))
		if want && err != nil {
			t.Fatalf("expected %s/%s after recovery: %v", owner, name, err)
		}
		if !want && !os.IsNotExist(err) {
			t.Fatalf("unexpected %s/%s after recovery: %v", owner, name, err)
		}
	}
	assertStoragePath(alice.Username, deleted.Name, false)
	assertStoragePath(alice.Username, committed.Name, false)
	assertStoragePath(bob.Username, committed.Name, true)
	assertStoragePath(alice.Username, rolledBack.Name, true)
	assertStoragePath(bob.Username, rolledBack.Name, false)
}

func requireStorageFence(t *testing.T, err error) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !stdErrors.As(err, &pgErr) || pgErr.Code != "55006" {
		t.Fatalf("expected repository storage fence SQLSTATE 55006, got %v", err)
	}
}

func insertStorageRecoveryJob(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id int64, operation, token, route string, sourceID int64, sourceOwner, sourceRepo string, targetID int64, targetOwner string) {
	t.Helper()
	var dstOwner, dstRepo, dstID any
	if operation == "move" {
		dstOwner, dstRepo, dstID = targetOwner, sourceRepo, targetID
	}
	if _, err := pool.Exec(ctx, `INSERT INTO repository_storage_operations
		(repository_id,operation_type,token,storage_route_key,source_owner,source_repo,source_user_id,
		 target_owner,target_repo,target_user_id,created_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()-interval '20 minutes')`,
		id, operation, token, route, sourceOwner, sourceRepo, sourceID, dstOwner, dstRepo, dstID); err != nil {
		t.Fatal(fmt.Errorf("persist %s receipt: %w", operation, err))
	}
}
