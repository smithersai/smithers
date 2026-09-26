package admission_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

func database(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	// Concurrent admission cases hold more connections than the default pool.
	pool, err := postgresfixture.Open(ctx, testdb.New(t).URL, 8)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	require.NoError(t, product.Apply(ctx, pool))
	return pool
}

func user(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()
	var id int64
	name := "u" + strings.ReplaceAll(uuid.NewString(), "-", "")
	require.NoError(t, pool.QueryRow(context.Background(), `INSERT INTO users
		(username, lower_username, email, lower_email, display_name)
		VALUES ($1::text, $1::text, $1::text || '@example.test', $1::text || '@example.test', $1::text) RETURNING id`, name).Scan(&id))
	return id
}

func repository(t *testing.T, pool *pgxpool.Pool, owner int64) int64 {
	t.Helper()
	var id int64
	name := "r" + strings.ReplaceAll(uuid.NewString(), "-", "")
	require.NoError(t, pool.QueryRow(context.Background(), `INSERT INTO repositories
		(user_id, name, lower_name, is_public, default_bookmark)
		VALUES ($1, $2, $2, false, 'main') RETURNING id`, owner, name).Scan(&id))
	return id
}

func TestMeteredConcurrentCreatesEnforceCapWithoutPaymentKeys(t *testing.T) {
	pool := database(t)
	owner := user(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := pool.Exec(ctx, `INSERT INTO repositories (user_id, name, lower_name, is_public, default_bookmark)
		SELECT $1, 'repo-' || i, 'repo-' || i, false, 'main' FROM generate_series(1, 99) i`, owner)
	require.NoError(t, err)
	policy, err := admission.NewMetered(pool, admission.Config{Usage: admission.ProductUsage})
	require.NoError(t, err)
	entered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	first := make(chan error, 1)
	go func() {
		first <- policy.AuthorizePrivateRepoCommitted(ctx, "user", owner, func(ctx context.Context) error {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			_, err := pool.Exec(ctx, `INSERT INTO repositories (user_id, name, lower_name, is_public, default_bookmark)
				VALUES ($1, 'winner', 'winner', false, 'main')`, owner)
			return err
		})
	}()
	select {
	case <-entered:
	case err := <-first:
		t.Fatalf("first admission failed before commit: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	second := make(chan error, 1)
	go func() {
		second <- policy.AuthorizePrivateRepoCommitted(ctx, "user", owner, func(ctx context.Context) error {
			_, err := pool.Exec(ctx, `INSERT INTO repositories (user_id, name, lower_name, is_public, default_bookmark)
				VALUES ($1, 'loser', 'loser', false, 'main')`, owner)
			return err
		})
	}()
	// Observe the real PostgreSQL wait; a start channel or timer alone does not
	// prove the second authorization actually encountered the first lock.
	for {
		var waiters int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE datname=current_database() AND wait_event='advisory'`).Scan(&waiters))
		if waiters == 1 {
			break
		}
		select {
		case err := <-second:
			t.Fatalf("second admission bypassed owner lock: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
	releaseOnce.Do(func() { close(release) })
	require.NoError(t, <-first)
	require.ErrorContains(t, <-second, "private repositories")
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repositories WHERE user_id=$1 AND NOT is_public`, owner).Scan(&count))
	require.Equal(t, 100, count)
}

// This is a deployment adapter over actual PostgreSQL data, not a policy mock.
// ProductUsage still measures every canonical product allocation.
type retainedUsage struct {
	admission.Usage
	conn admission.DBTX
}

func (u retainedUsage) SumStorageBytesByOwner(ctx context.Context, owner admission.Owner) (int64, error) {
	base, err := u.Usage.SumStorageBytesByOwner(ctx, owner)
	if err != nil {
		return 0, err
	}
	var extra int64
	err = u.conn.QueryRow(ctx, `SELECT coalesce(sum(size_bytes),0) FROM private_allocations WHERE owner_type=$1 AND owner_id=$2`, owner.OwnerType, owner.OwnerID).Scan(&extra)
	return base + extra, err
}

func (u retainedUsage) SumStorageBytesByRepository(ctx context.Context, id int64) (int64, error) {
	base, err := u.Usage.SumStorageBytesByRepository(ctx, id)
	if err != nil {
		return 0, err
	}
	var extra int64
	err = u.conn.QueryRow(ctx, `SELECT coalesce(sum(size_bytes),0) FROM private_allocations WHERE repository_id=$1`, id).Scan(&extra)
	return base + extra, err
}

func TestMeteredTransferRebindsPrivateUsageToCallerDBTX(t *testing.T) {
	pool := database(t)
	source, target := user(t, pool), user(t, pool)
	repo := repository(t, pool, source)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := pool.Exec(ctx, `CREATE TABLE private_allocations (repository_id bigint, owner_type text, owner_id bigint, size_bytes bigint)`)
	require.NoError(t, err)
	var rebound []admission.DBTX
	policy, err := admission.NewMetered(pool, admission.Config{Usage: func(conn admission.DBTX) (admission.Usage, error) {
		rebound = append(rebound, conn)
		product, err := admission.ProductUsage(conn)
		return retainedUsage{product, conn}, err
	}})
	require.NoError(t, err)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(context.Background())
	const capBytes int64 = 100 * 1024 * 1024 * 1024
	// Only this transaction can see the retained source allocation.
	_, err = tx.Exec(ctx, `INSERT INTO private_allocations VALUES ($1, 'user', $2, $3)`, repo, source, capBytes+1)
	require.NoError(t, err)
	called := false
	err = policy.AuthorizeRepositoryTransferCommittedInTransaction(ctx, tx, repo, "user", target, true, func(ctx context.Context) error {
		called = true
		_, err := tx.Exec(ctx, `UPDATE repositories SET description='incorrectly admitted' WHERE id=$1`, repo)
		return err
	})
	require.ErrorContains(t, err, "storage")
	require.False(t, called)
	require.Len(t, rebound, 2)
	require.Same(t, tx, rebound[1], "private usage must bind to the caller's exact transaction")
}

func TestMeteredTransactionUsageFailureDoesNotCommit(t *testing.T) {
	pool := database(t)
	owner := user(t, pool)
	bindFailure := errors.New("usage authority unavailable")
	policy, err := admission.NewMetered(pool, admission.Config{Usage: func(conn admission.DBTX) (admission.Usage, error) {
		if conn != pool {
			return nil, bindFailure
		}
		return admission.ProductUsage(conn)
	}})
	require.NoError(t, err)
	called := false
	err = policy.AuthorizePrivateRepoCommitted(context.Background(), "user", owner, func(context.Context) error {
		called = true
		return fmt.Errorf("must not reach consuming write")
	})
	require.ErrorIs(t, err, bindFailure)
	require.False(t, called)
}

type pendingRepoUsage struct {
	admission.Usage
	conn admission.DBTX
}

func (u pendingRepoUsage) CountPrivateReposByOwner(ctx context.Context, owner admission.RepoOwner) (int64, error) {
	base, err := u.Usage.CountPrivateReposByOwner(ctx, owner)
	if err != nil {
		return 0, err
	}
	var pending int64
	err = u.conn.QueryRow(ctx, `SELECT count(*) FROM private_pending_repos WHERE owner_type=$1 AND owner_id=$2`, owner.OwnerType, owner.OwnerID).Scan(&pending)
	return base + pending, err
}

func TestMeteredPrivateRepoCapCountsDeploymentReservations(t *testing.T) {
	pool := database(t)
	owner := user(t, pool)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `CREATE TABLE private_pending_repos (owner_type text, owner_id bigint)`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO repositories (user_id, name, lower_name, is_public, default_bookmark)
		SELECT $1, 'repo-' || i, 'repo-' || i, false, 'main' FROM generate_series(1, 99) i`, owner)
	require.NoError(t, err)
	policy, err := admission.NewMetered(pool, admission.Config{Usage: func(conn admission.DBTX) (admission.Usage, error) {
		product, err := admission.ProductUsage(conn)
		return pendingRepoUsage{product, conn}, err
	}})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO private_pending_repos VALUES ('user', $1)`, owner)
	require.NoError(t, err)
	called := false
	err = policy.AuthorizePrivateRepoCommitted(ctx, "user", owner, func(context.Context) error {
		called = true
		return nil
	})
	require.ErrorContains(t, err, "private repositories")
	require.False(t, called, "a reserved, unpublished private repository holds the last slot")

	_, err = pool.Exec(ctx, `DELETE FROM private_pending_repos`)
	require.NoError(t, err)
	require.NoError(t, policy.AuthorizePrivateRepoCommitted(ctx, "user", owner, func(context.Context) error {
		called = true
		return nil
	}))
	require.True(t, called)
}
