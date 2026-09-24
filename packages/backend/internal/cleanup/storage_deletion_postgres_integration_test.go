package cleanup

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/database"
)

// clusterSchemaPath finds the combined product and private schema that holds
// storage_deletion_queue and its LFS re-admission triggers. Set
// SMITHERS_CLUSTER_SCHEMA to use a schema file outside this checkout.
func clusterSchemaPath(t *testing.T) string {
	t.Helper()
	for _, candidate := range []string{
		os.Getenv("SMITHERS_CLUSTER_SCHEMA"),
		filepath.Join("..", "..", "db", "cluster", "sqlc_schema.sql"),
	} {
		if candidate == "" {
			continue
		}
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
		t.Fatal("cluster schema not found; set SMITHERS_CLUSTER_SCHEMA")
	}
	t.Skip("cluster schema not found; set SMITHERS_CLUSTER_SCHEMA")
	return ""
}

// newStorageDeletionTestPool creates an isolated database with the combined
// product and private schema, where storage_deletion_queue and its LFS
// re-admission triggers live.
func newStorageDeletionTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("SMITHERS_CLUSTER_TEST_DATABASE_URL")
	if raw == "" {
		raw = os.Getenv("SMITHERS_TEST_DATABASE_URL")
	}
	if raw == "" {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("SMITHERS_CLUSTER_TEST_DATABASE_URL is required")
		}
		t.Skip("set SMITHERS_CLUSTER_TEST_DATABASE_URL for storage deletion integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	adminURL, err := url.Parse(raw)
	require.NoError(t, err)
	adminURL.Path = "/postgres"
	admin, err := pgx.Connect(ctx, adminURL.String())
	require.NoError(t, err)
	var suffix [8]byte
	_, err = rand.Read(suffix[:])
	require.NoError(t, err)
	name := "smithers_storage_deletion_" + hex.EncodeToString(suffix[:])
	_, err = admin.Exec(ctx, `CREATE DATABASE "`+name+`"`)
	require.NoError(t, err)
	t.Cleanup(func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer closeCancel()
		if _, err := admin.Exec(closeCtx, `DROP DATABASE "`+name+`" WITH (FORCE)`); err != nil {
			t.Errorf("drop storage deletion test database: %v", err)
		}
		_ = admin.Close(closeCtx)
	})

	dbURL := *adminURL
	dbURL.Path = "/" + name
	schema, err := os.ReadFile(clusterSchemaPath(t))
	require.NoError(t, err)
	conn, err := pgx.Connect(ctx, dbURL.String())
	require.NoError(t, err)
	_, err = conn.Exec(ctx, string(schema))
	require.NoError(t, err)
	require.NoError(t, conn.Close(ctx))

	cfg, err := pgxpool.ParseConfig(dbURL.String())
	require.NoError(t, err)
	cfg.AfterConnect = func(_ context.Context, conn *pgx.Conn) error {
		database.ConfigureSQLCTypes(conn.TypeMap())
		return nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	return pool
}

type storageDeletionSeed struct {
	repoID    int64
	oid       string
	objectKey string
	rowID     int64
}

func seedStorageDeletion(t *testing.T, pool *pgxpool.Pool) storageDeletionSeed {
	return seedStorageDeletionAt(t, pool, "")
}

// seedStorageDeletionAt queues an LFS allocation. An empty keyPrefix uses the
// canonical repos/<id>/lfs/<oid> key the re-admission triggers match.
func seedStorageDeletionAt(t *testing.T, pool *pgxpool.Pool, keyPrefix string) storageDeletionSeed {
	t.Helper()
	ctx := context.Background()
	var suffix [6]byte
	_, err := rand.Read(suffix[:])
	require.NoError(t, err)
	tag := hex.EncodeToString(suffix[:])

	var userID, repoID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (username, lower_username, email, lower_email, display_name, is_active)
		 VALUES ($1, $1, $2, $2, $1, true) RETURNING id`, "sdq_"+tag, "sdq_"+tag+"@example.com").Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO repositories (user_id, name, lower_name) VALUES ($1, $2, $2) RETURNING id`,
		userID, "repo_"+tag).Scan(&repoID))

	seed := storageDeletionSeed{repoID: repoID, oid: "oid" + tag}
	seed.objectKey = "repos/" + strconv.FormatInt(repoID, 10) + "/lfs/" + seed.oid
	if keyPrefix != "" {
		seed.objectKey = keyPrefix + seed.oid
	}
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO storage_deletion_queue (repository_id, owner_type, owner_id, allocation_key, object_key, size_bytes, delete_after)
		 VALUES ($1, 'user', $2, $3, $4, 10, NOW() - INTERVAL '1 minute') RETURNING id`,
		repoID, userID, "lfs:"+strconv.FormatInt(repoID, 10)+":"+seed.oid, seed.objectKey).Scan(&seed.rowID))
	return seed
}

func claimOne(t *testing.T, c *postgresStorageDeletionCoordinator, token string, lease time.Duration) clusterdb.StorageDeletionQueue {
	t.Helper()
	rows, err := c.Claim(context.Background(), token, lease, 10)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	return rows[0]
}

func queueRowCount(t *testing.T, pool *pgxpool.Pool, id int64) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT count(*) FROM storage_deletion_queue WHERE id = $1`, id).Scan(&n))
	return n
}

func TestPostgresStorageDeletionCoordinator(t *testing.T) {
	pool := newStorageDeletionTestPool(t)
	coordinator := &postgresStorageDeletionCoordinator{pool: pool}
	ctx := context.Background()

	t.Run("purges and deletes a claimed row", func(t *testing.T) {
		seed := seedStorageDeletion(t, pool)
		row := claimOne(t, coordinator, "token-success", time.Minute)
		var purged []string
		done, err := coordinator.Process(ctx, row, func(_ context.Context, key string) error {
			purged = append(purged, key)
			return nil
		})
		require.NoError(t, err)
		require.True(t, done)
		require.Equal(t, []string{seed.objectKey}, purged)
		require.Zero(t, queueRowCount(t, pool, seed.rowID))
	})

	t.Run("re-admission before the lock makes Process a no-op", func(t *testing.T) {
		seed := seedStorageDeletion(t, pool)
		row := claimOne(t, coordinator, "token-readmit", time.Minute)
		// The LFS re-admission trigger deletes the queue row for the key.
		_, err := pool.Exec(ctx, `INSERT INTO lfs_objects (repository_id, oid, size, gcs_path) VALUES ($1, $2, 10, $3)`,
			seed.repoID, seed.oid, seed.objectKey)
		require.NoError(t, err)
		done, err := coordinator.Process(ctx, row, func(context.Context, string) error {
			t.Fatal("purge must not run after re-admission")
			return nil
		})
		require.NoError(t, err)
		require.False(t, done)
	})

	t.Run("re-admission during the purge waits for the purge to finish", func(t *testing.T) {
		seed := seedStorageDeletion(t, pool)
		row := claimOne(t, coordinator, "token-race", time.Minute)
		purgeFinished := make(chan struct{})
		readmitted := make(chan error, 1)
		done, err := coordinator.Process(ctx, row, func(context.Context, string) error {
			go func() {
				_, err := pool.Exec(ctx, `INSERT INTO lfs_objects (repository_id, oid, size, gcs_path) VALUES ($1, $2, 10, $3)`,
					seed.repoID, seed.oid, seed.objectKey)
				select {
				case <-purgeFinished:
					readmitted <- err
				default:
					readmitted <- errors.New("re-admission committed while the purge still held the row")
				}
			}()
			time.Sleep(300 * time.Millisecond)
			close(purgeFinished)
			return nil
		})
		require.NoError(t, err)
		require.True(t, done)
		require.NoError(t, <-readmitted)
	})

	t.Run("an active key resolves without a purge", func(t *testing.T) {
		// A legacy custom key is outside the re-admission triggers, so the row
		// survives while the same allocation becomes live again.
		seed := seedStorageDeletionAt(t, pool, "legacy/custom/")
		row := claimOne(t, coordinator, "token-active", time.Minute)
		_, err := pool.Exec(ctx, `INSERT INTO lfs_objects (repository_id, oid, size, gcs_path) VALUES ($1, $2, 10, $3)`,
			seed.repoID, seed.oid, "repos/"+strconv.FormatInt(seed.repoID, 10)+"/lfs/"+seed.oid)
		require.NoError(t, err)
		require.Equal(t, 1, queueRowCount(t, pool, seed.rowID))
		done, err := coordinator.Process(ctx, row, func(context.Context, string) error {
			t.Fatal("an active key must not be purged")
			return nil
		})
		require.NoError(t, err)
		require.True(t, done)
		require.Zero(t, queueRowCount(t, pool, seed.rowID))
	})

	t.Run("purge failure releases the claim with last_error", func(t *testing.T) {
		seed := seedStorageDeletion(t, pool)
		row := claimOne(t, coordinator, "token-fail", time.Minute)
		done, err := coordinator.Process(ctx, row, func(context.Context, string) error {
			return errors.New("bucket unavailable")
		})
		require.ErrorContains(t, err, "bucket unavailable")
		require.False(t, done)
		var claimToken *string
		var attempts int
		var lastError string
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT claim_token, attempts, last_error FROM storage_deletion_queue WHERE id = $1`, seed.rowID).
			Scan(&claimToken, &attempts, &lastError))
		require.Nil(t, claimToken)
		require.Equal(t, 1, attempts)
		require.Contains(t, lastError, "bucket unavailable")
	})

	t.Run("a stale claim token cannot process a reclaimed row", func(t *testing.T) {
		seed := seedStorageDeletion(t, pool)
		stale := claimOne(t, coordinator, "token-stale", time.Minute)
		_, err := pool.Exec(ctx, `UPDATE storage_deletion_queue SET claimed_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, seed.rowID)
		require.NoError(t, err)
		fresh := claimOne(t, coordinator, "token-fresh", time.Minute)
		require.Equal(t, seed.rowID, fresh.ID)
		done, err := coordinator.Process(ctx, stale, func(context.Context, string) error {
			t.Fatal("a stale claim must not purge")
			return nil
		})
		require.NoError(t, err)
		require.False(t, done)
		require.Equal(t, 1, queueRowCount(t, pool, seed.rowID))
	})
}
