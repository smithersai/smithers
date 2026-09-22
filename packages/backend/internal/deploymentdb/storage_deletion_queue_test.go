package deploymentdb

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func insertWorkflowCacheForDeletionTest(t *testing.T, tx DBTX, repositoryID int64, objectKey string, size int64) int64 {
	t.Helper()
	var id int64
	err := tx.QueryRow(context.Background(), `
		INSERT INTO workflow_caches (
			repository_id, bookmark_name, cache_key, cache_version, object_key,
			object_size_bytes, compression, status, expires_at
		) VALUES ($1, 'main', $2, 'v1', $3, $4, 'tar+gzip', 'pending', NOW() + INTERVAL '1 hour')
		RETURNING id
	`, repositoryID, objectKey, objectKey, size).Scan(&id)
	require.NoError(t, err)
	return id
}

func queueCount(t *testing.T, tx DBTX, repositoryID int64) int64 {
	t.Helper()
	var count int64
	require.NoError(t, tx.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM storage_deletion_queue WHERE repository_id = $1`, repositoryID,
	).Scan(&count))
	return count
}

func TestStorageDeletionQueueDirectDeleteIsIdempotentAndBillable(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), "queue-direct")
	cacheID := insertWorkflowCacheForDeletionTest(t, tx, repoID, "cache/old.tgz", 55)

	before, err := q.SumStorageBytesByOwner(ctx, SumStorageBytesByOwnerParams{OwnerType: "user", OwnerID: userID})
	require.NoError(t, err)
	assert.Equal(t, int64(55), before)

	_, err = tx.Exec(ctx, `DELETE FROM workflow_caches WHERE id = $1`, cacheID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), queueCount(t, tx, repoID), "final and pending exact keys are both durable")

	// Re-enqueueing the same keys merges rather than double-counting them.
	_, err = tx.Exec(ctx, `SELECT enqueue_storage_deletion($1, 'user', $2, $3, $4, 55, NOW())`,
		repoID, userID, "workflow-cache:"+itoa(repoID)+":cache/old.tgz", "cache/old.tgz")
	require.NoError(t, err)
	assert.Equal(t, int64(2), queueCount(t, tx, repoID))

	after, err := q.SumStorageBytesByOwner(ctx, SumStorageBytesByOwnerParams{OwnerType: "user", OwnerID: userID})
	require.NoError(t, err)
	assert.Equal(t, int64(55), after, "pending/final keys share one billed allocation")
	repoUsage, err := q.SumStorageBytesByRepository(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, int64(55), repoUsage)
	cacheUsage, err := q.GetWorkflowCacheRepoUsage(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, int64(55), cacheUsage, "cache-specific admission includes retained queue allocations")
}

func TestLegacyFinalKeyCapabilityHorizonFailsClosedAndCanOnlyExtend(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), "queue-legacy-horizon")
	allocationKey := "workflow-artifact:987654"
	finalKey := "workflow-artifacts/final.bin"
	pendingKey := "pending/workflow-artifacts/workflow-artifacts/final.bin"

	allowed, err := q.IsLegacyFinalKeyPurgeAllowed(ctx)
	require.NoError(t, err)
	assert.False(t, allowed, "the seeded infinity horizon must fail closed")

	_, err = tx.Exec(ctx, `SELECT enqueue_storage_deletion($1, 'user', $2, $3, $4, 17, NOW())`,
		repoID, userID, allocationKey, finalKey)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `SELECT enqueue_storage_deletion($1, 'user', $2, $3, $4, 17, NOW())`,
		repoID, userID, allocationKey, pendingKey)
	require.NoError(t, err)

	var finalIsFenced, finalHasRequested, pendingIsFenced, pendingHasRequested bool
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT
			delete_after = TIMESTAMPTZ '9999-12-31 23:59:59+00',
			requested_delete_after IS NOT NULL
		FROM storage_deletion_queue
		WHERE object_key = $1
	`, finalKey).Scan(&finalIsFenced, &finalHasRequested))
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT
			delete_after = TIMESTAMPTZ '9999-12-31 23:59:59+00',
			requested_delete_after IS NOT NULL
		FROM storage_deletion_queue
		WHERE object_key = $1
	`, pendingKey).Scan(&pendingIsFenced, &pendingHasRequested))
	assert.True(t, finalIsFenced)
	assert.True(t, finalHasRequested)
	assert.False(t, pendingIsFenced)
	assert.False(t, pendingHasRequested)

	claimed, err := q.ClaimStorageDeletions(ctx, ClaimStorageDeletionsParams{
		ClaimToken:   pgtype.Text{String: "pending-only", Valid: true},
		LeaseSeconds: 300,
		LimitRows:    10,
	})
	require.NoError(t, err)
	require.Len(t, claimed, 1, "only the staging key is due before attestation")
	assert.Equal(t, pendingKey, claimed[0].ObjectKey)
	_, err = q.DeleteClaimedStorageDeletion(ctx, DeleteClaimedStorageDeletionParams{
		ID: claimed[0].ID, ClaimToken: claimed[0].ClaimToken,
	})
	require.NoError(t, err)

	// These short future horizons keep the test fast while exercising the same
	// absolute-timestamp attestation path used by the operator runbook.
	_, err = tx.Exec(ctx, `
		UPDATE storage_legacy_capability_horizons
		SET valid_until = clock_timestamp() + INTERVAL '1 second',
		    attested_by = 'integration-test',
		    attestation = 'legacy signer pod UIDs drained; test evidence'
		WHERE capability_kind = 'legacy-final-key-upload'
	`)
	require.NoError(t, err)
	allowed, err = q.IsLegacyFinalKeyPurgeAllowed(ctx)
	require.NoError(t, err)
	assert.False(t, allowed)

	// Corrections are safe only before the former horizon passes, when no purge
	// can have opened. They may extend but never shorten the evidence window.
	_, err = tx.Exec(ctx, `
		UPDATE storage_legacy_capability_horizons
		SET valid_until = clock_timestamp() + INTERVAL '2 seconds',
		    attested_by = 'integration-test',
		    attestation = 'corrected legacy maximum before purge opened'
		WHERE capability_kind = 'legacy-final-key-upload'
	`)
	require.NoError(t, err)
	allowed, err = q.IsLegacyFinalKeyPurgeAllowed(ctx)
	require.NoError(t, err)
	assert.False(t, allowed)

	shortenErr := mustExpectError(t, tx, func(sp DBTX) error {
		_, updateErr := sp.Exec(ctx, `
			UPDATE storage_legacy_capability_horizons
			SET valid_until = valid_until - INTERVAL '1 millisecond',
			    attested_by = 'integration-test',
			    attestation = 'unsafe shortening attempt'
			WHERE capability_kind = 'legacy-final-key-upload'
		`)
		return updateErr
	})
	assert.Error(t, shortenErr)

	var validUntil time.Time
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT valid_until
		FROM storage_legacy_capability_horizons
		WHERE capability_kind = 'legacy-final-key-upload'
	`).Scan(&validUntil))
	if wait := time.Until(validUntil) + 100*time.Millisecond; wait > 0 {
		time.Sleep(wait)
	}
	allowed, err = q.IsLegacyFinalKeyPurgeAllowed(ctx)
	require.NoError(t, err)
	assert.True(t, allowed)

	claimed, err = q.ClaimStorageDeletions(ctx, ClaimStorageDeletionsParams{
		ClaimToken:   pgtype.Text{String: "final-after-horizon", Valid: true},
		LeaseSeconds: 300,
		LimitRows:    10,
	})
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	assert.Equal(t, finalKey, claimed[0].ObjectKey)

	lateExtensionErr := mustExpectError(t, tx, func(sp DBTX) error {
		_, updateErr := sp.Exec(ctx, `
			UPDATE storage_legacy_capability_horizons
			SET valid_until = clock_timestamp() + INTERVAL '1 hour',
			    attested_by = 'integration-test',
			    attestation = 'late evidence after purge opened'
			WHERE capability_kind = 'legacy-final-key-upload'
		`)
		return updateErr
	})
	assert.Error(t, lateExtensionErr)

	deleteErr := mustExpectError(t, tx, func(sp DBTX) error {
		_, removeErr := sp.Exec(ctx, `
			DELETE FROM storage_legacy_capability_horizons
			WHERE capability_kind = 'legacy-final-key-upload'
		`)
		return removeErr
	})
	assert.Error(t, deleteErr)
}

func TestStorageDeletionQueueRollbackAndCacheKeyUpdate(t *testing.T) {
	ctx := context.Background()
	_, txDB := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, txDB, uniqueTestUsername(t), "queue-rollback")
	_ = userID
	cacheID := insertWorkflowCacheForDeletionTest(t, txDB, repoID, "cache/original.tgz", 21)

	tx := txDB.(pgx.Tx)
	sp, err := tx.Begin(ctx)
	require.NoError(t, err)
	mustDurablyDeleteRepoForTest(t, sp, repoID)
	var inside int64
	require.NoError(t, sp.QueryRow(ctx, `SELECT COUNT(*) FROM storage_deletion_queue WHERE repository_id = $1`, repoID).Scan(&inside))
	assert.Equal(t, int64(2), inside)
	require.NoError(t, sp.Rollback(ctx))
	assert.Zero(t, queueCount(t, txDB, repoID), "repository rollback must roll back queue insertion")

	_, err = txDB.Exec(ctx, `UPDATE workflow_caches SET object_key = 'cache/replacement.tgz' WHERE id = $1`, cacheID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), queueCount(t, txDB, repoID))
	var allocation string
	require.NoError(t, txDB.QueryRow(ctx, `
		SELECT allocation_key FROM storage_deletion_queue
		WHERE object_key = 'cache/original.tgz'
	`).Scan(&allocation))
	assert.Contains(t, allocation, "cache/original.tgz", "old nonce/key is a distinct allocation")
}

func TestStorageDeletionQueueSurvivesOwnerRemovalAfterExplicitRepositoryDelete(t *testing.T) {
	ctx := context.Background()
	t.Run("user", func(t *testing.T) {
		q, tx := newQueries(t)
		userID, repoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), "queue-user-cascade")
		insertWorkflowCacheForDeletionTest(t, tx, repoID, "cache/user.tgz", 31)
		mustDurablyDeleteRepoForTest(t, tx, repoID)
		_, err := tx.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID)
		require.NoError(t, err)
		assert.Equal(t, int64(2), queueCount(t, tx, repoID))
		usage, err := q.SumStorageBytesByOwner(ctx, SumStorageBytesByOwnerParams{OwnerType: "user", OwnerID: userID})
		require.NoError(t, err)
		assert.Equal(t, int64(31), usage, "denormalized owner remains billed after cascade")
	})

	t.Run("organization", func(t *testing.T) {
		q, tx := newQueries(t)
		orgID := mustCreateOrganization(t, tx, uniqueTestUsername(t))
		repoID := mustCreateOrgRepo(t, tx, orgID, "queue-org-cascade", true)
		insertWorkflowCacheForDeletionTest(t, tx, repoID, "cache/org.tgz", 37)
		mustDurablyDeleteRepoForTest(t, tx, repoID)
		_, err := tx.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)
		require.NoError(t, err)
		assert.Equal(t, int64(2), queueCount(t, tx, repoID))
		usage, err := q.SumStorageBytesByOwner(ctx, SumStorageBytesByOwnerParams{OwnerType: "org", OwnerID: orgID})
		require.NoError(t, err)
		assert.Equal(t, int64(37), usage)
	})
}

func TestStorageDeletionQueueRetargetsOnRepositoryTransfer(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), "queue-transfer")
	orgID := mustCreateOrganization(t, tx, uniqueTestUsername(t))
	_, err := tx.Exec(ctx, `
		INSERT INTO storage_deletion_queue (
			repository_id, owner_type, owner_id, allocation_key, object_key,
			size_bytes, delete_after
		) VALUES ($1, 'user', $2, 'transfer-allocation', 'transfer/key', 19, NOW())
	`, repoID, userID)
	require.NoError(t, err)

	mustDurablyMoveRepoForTest(t, tx, repoID, pgtype.Int8{}, pgtype.Int8{Int64: orgID, Valid: true})
	var ownerType string
	var ownerID int64
	require.NoError(t, tx.QueryRow(ctx,
		`SELECT owner_type, owner_id FROM storage_deletion_queue WHERE object_key = 'transfer/key'`,
	).Scan(&ownerType, &ownerID))
	assert.Equal(t, "org", ownerType)
	assert.Equal(t, orgID, ownerID)

	oldUsage, err := q.SumStorageBytesByOwner(ctx, SumStorageBytesByOwnerParams{OwnerType: "user", OwnerID: userID})
	require.NoError(t, err)
	newUsage, err := q.SumStorageBytesByOwner(ctx, SumStorageBytesByOwnerParams{OwnerType: "org", OwnerID: orgID})
	require.NoError(t, err)
	assert.Zero(t, oldUsage)
	assert.Equal(t, int64(19), newUsage)
}

func TestStorageDeletionQueueDirectReleaseAndRepositoryParents(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), "queue-parent-delete")
	insertWorkflowCacheForDeletionTest(t, tx, repoID, "cache/parent.tgz", 23)

	var releaseID int64
	require.NoError(t, tx.QueryRow(ctx, `
		INSERT INTO releases (repository_id, publisher_id, tag_name)
		VALUES ($1, $2, 'v-queue-test')
		RETURNING id
	`, repoID, userID).Scan(&releaseID))
	var assetID int64
	require.NoError(t, tx.QueryRow(ctx, `
		INSERT INTO release_assets (
			release_id, uploader_id, name, size, status, gcs_key
		) VALUES ($1, $2, 'asset.bin', 17, 'pending', 'releases/exact-asset-key')
		RETURNING id
	`, releaseID, userID).Scan(&assetID))

	_, err := tx.Exec(ctx, `DELETE FROM releases WHERE id = $1`, releaseID)
	require.NoError(t, err)
	var releaseKeys int64
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT COUNT(*) FROM storage_deletion_queue
		WHERE allocation_key = $1
		  AND object_key IN (
		      'releases/exact-asset-key',
		      'pending/release-assets/releases/exact-asset-key'
		  )
	`, "release-asset:"+itoa(assetID)).Scan(&releaseKeys))
	assert.Equal(t, int64(2), releaseKeys, "release parent must enqueue before asset cascade")

	usage, err := q.SumStorageBytesByOwner(ctx, SumStorageBytesByOwnerParams{OwnerType: "user", OwnerID: userID})
	require.NoError(t, err)
	assert.Equal(t, int64(40), usage, "live cache plus queued release allocation remain billed")

	mustDurablyDeleteRepoForTest(t, tx, repoID)
	assert.Equal(t, int64(4), queueCount(t, tx, repoID), "direct repo delete enqueues its cache without losing release tombstones")
	usage, err = q.SumStorageBytesByOwner(ctx, SumStorageBytesByOwnerParams{OwnerType: "user", OwnerID: userID})
	require.NoError(t, err)
	assert.Equal(t, int64(40), usage, "direct repository deletion preserves allocation billing")
}

func TestStorageDeletionQueueClaimReleaseRetryProtocol(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), "queue-claim")
	_, err := tx.Exec(ctx, `
		INSERT INTO storage_deletion_queue (
			repository_id, owner_type, owner_id, allocation_key, object_key,
			size_bytes, delete_after
		) VALUES ($1, 'user', $2, 'retry-allocation', 'retry/exact-key', 29, NOW())
	`, repoID, userID)
	require.NoError(t, err)

	firstToken := pgtype.Text{String: "first-token", Valid: true}
	claimed, err := q.ClaimStorageDeletions(ctx, ClaimStorageDeletionsParams{
		ClaimToken: firstToken, LeaseSeconds: 300, LimitRows: 10,
	})
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	assert.Equal(t, firstToken, claimed[0].ClaimToken)

	released, err := q.ReleaseClaimedStorageDeletion(ctx, ReleaseClaimedStorageDeletionParams{
		ID: claimed[0].ID, ClaimToken: firstToken, LastError: "temporary gcs failure",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), released)
	var attempts int32
	var lastError string
	var token pgtype.Text
	var nextAttempt time.Time
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT attempts, last_error, claim_token, delete_after
		FROM storage_deletion_queue WHERE id = $1
	`, claimed[0].ID).Scan(&attempts, &lastError, &token, &nextAttempt))
	assert.Equal(t, int32(1), attempts)
	assert.Equal(t, "temporary gcs failure", lastError)
	assert.False(t, token.Valid)
	assert.True(t, nextAttempt.After(claimed[0].DeleteAfter), "a failed row must move behind other due work")

	usage, err := q.SumStorageBytesByOwner(ctx, SumStorageBytesByOwnerParams{OwnerType: "user", OwnerID: userID})
	require.NoError(t, err)
	assert.Equal(t, int64(29), usage, "failed cleanup remains billed")

	secondToken := pgtype.Text{String: "second-token", Valid: true}
	retried, err := q.ClaimStorageDeletions(ctx, ClaimStorageDeletionsParams{
		ClaimToken: secondToken, LeaseSeconds: 300, LimitRows: 10,
	})
	require.NoError(t, err)
	assert.Empty(t, retried, "a released failure must observe retry backoff")

	_, err = tx.Exec(ctx, `UPDATE storage_deletion_queue SET delete_after = NOW() - INTERVAL '1 second' WHERE id = $1`, claimed[0].ID)
	require.NoError(t, err)
	retried, err = q.ClaimStorageDeletions(ctx, ClaimStorageDeletionsParams{
		ClaimToken: secondToken, LeaseSeconds: 300, LimitRows: 10,
	})
	require.NoError(t, err)
	require.Len(t, retried, 1)
	assert.Equal(t, secondToken, retried[0].ClaimToken)

	wrongDelete, err := q.DeleteClaimedStorageDeletion(ctx, DeleteClaimedStorageDeletionParams{
		ID: retried[0].ID, ClaimToken: firstToken,
	})
	require.NoError(t, err)
	assert.Zero(t, wrongDelete, "stale token cannot release billing metadata")
	deleted, err := q.DeleteClaimedStorageDeletion(ctx, DeleteClaimedStorageDeletionParams{
		ID: retried[0].ID, ClaimToken: secondToken,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), deleted)
}

func TestStorageDeletionQueueActiveCheckUsesLFSAllocationIdentity(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	_, repoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), "queue-active-allocation")
	oid := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	_, err := tx.Exec(ctx, `
		INSERT INTO lfs_objects (repository_id, oid, size, gcs_path)
		VALUES ($1, $2, 13, 'legacy/custom/final-path')
	`, repoID, oid)
	require.NoError(t, err)

	active, err := q.IsStorageDeletionObjectActive(ctx, IsStorageDeletionObjectActiveParams{
		RepositoryID: repoID, AllocationKey: fmt.Sprintf("lfs:%d:%s", repoID, oid),
	})
	require.NoError(t, err)
	assert.True(t, active, "repository+OID identity must protect custom legacy final paths")

	nonLFS, err := q.IsStorageDeletionObjectActive(ctx, IsStorageDeletionObjectActiveParams{
		RepositoryID: repoID, AllocationKey: "workflow-cache:legacy/custom/final-path",
	})
	require.NoError(t, err)
	assert.False(t, nonLFS, "immutable namespaces must bypass LFS table probes")

	wrongRepo, err := q.IsStorageDeletionObjectActive(ctx, IsStorageDeletionObjectActiveParams{
		RepositoryID: repoID + 1, AllocationKey: fmt.Sprintf("lfs:%d:%s", repoID, oid),
	})
	require.NoError(t, err)
	assert.False(t, wrongRepo, "allocation identity must be repository fenced")

}

func TestPendingWorkflowCacheClaimKeepsReservationExpiryOnDelete(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	_, repoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), "queue-pending-cache-origin")
	expiresAt := time.Now().UTC().Add(90 * time.Minute)
	cacheID := insertWorkflowCacheForDeletionTest(t, tx, repoID, "cache/pending-origin.tgz", 17)
	_, err := tx.Exec(ctx, `UPDATE workflow_caches SET expires_at = $2 WHERE id = $1`, cacheID, expiresAt)
	require.NoError(t, err)

	token := pgtype.Text{String: "pending-origin-token", Valid: true}
	claimed, err := q.ClaimWorkflowCacheDeletion(ctx, ClaimWorkflowCacheDeletionParams{
		ID: cacheID, RepositoryID: repoID, WorkflowRunID: pgtype.Int8{},
		ObjectKey: "cache/pending-origin.tgz", ExpectedStatus: "pending", DeletionToken: token,
	})
	require.NoError(t, err)
	assert.Equal(t, "deleting", claimed.Status)
	assert.False(t, claimed.FinalizedAt.Valid)

	_, err = q.DeleteClaimedWorkflowCache(ctx, DeleteClaimedWorkflowCacheParams{
		ID: cacheID, RepositoryID: repoID, WorkflowRunID: pgtype.Int8{},
		ObjectKey: "cache/pending-origin.tgz", DeletionToken: token,
	})
	require.NoError(t, err)

	var queuedDeleteAfter time.Time
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT delete_after
		FROM storage_deletion_queue
		WHERE repository_id = $1
		  AND object_key = 'pending/workflow-caches/cache/pending-origin.tgz'
	`, repoID).Scan(&queuedDeleteAfter))
	assert.WithinDuration(t, expiresAt, queuedDeleteAfter, time.Second,
		"claiming pending->deleting must not replace its reservation expiry with a seven-day finalized horizon")

	_, cascadeRepoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), "queue-pending-cache-cascade")
	cascadeExpiresAt := time.Now().UTC().Add(2 * time.Hour)
	cascadeCacheID := insertWorkflowCacheForDeletionTest(t, tx, cascadeRepoID, "cache/pending-cascade.tgz", 19)
	_, err = tx.Exec(ctx, `UPDATE workflow_caches SET expires_at = $2 WHERE id = $1`, cascadeCacheID, cascadeExpiresAt)
	require.NoError(t, err)
	cascadeToken := pgtype.Text{String: "pending-cascade-token", Valid: true}
	_, err = q.ClaimWorkflowCacheDeletion(ctx, ClaimWorkflowCacheDeletionParams{
		ID: cascadeCacheID, RepositoryID: cascadeRepoID, WorkflowRunID: pgtype.Int8{},
		ObjectKey: "cache/pending-cascade.tgz", ExpectedStatus: "pending", DeletionToken: cascadeToken,
	})
	require.NoError(t, err)
	mustDurablyDeleteRepoForTest(t, tx, cascadeRepoID)
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT delete_after
		FROM storage_deletion_queue
		WHERE repository_id = $1
		  AND object_key = 'pending/workflow-caches/cache/pending-cascade.tgz'
	`, cascadeRepoID).Scan(&queuedDeleteAfter))
	assert.WithinDuration(t, cascadeExpiresAt, queuedDeleteAfter, time.Second,
		"repository cascades must preserve the origin expiry of already-claimed pending caches")
}

func TestClearPurgedStorageDeletionByExactKeyRequiresCompleteAllocationIdentity(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), "queue-exact-clear")
	_, otherRepoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), "queue-exact-clear-other")

	for _, row := range []struct {
		repositoryID  int64
		allocationKey string
		objectKey     string
	}{
		{repoID, "workflow-artifact:41", "pending/workflow-artifacts/exact"},
		{repoID, "workflow-artifact:42", "pending/workflow-artifacts/other-allocation"},
		{otherRepoID, "workflow-artifact:41", "pending/workflow-artifacts/other-repository"},
	} {
		_, err := tx.Exec(ctx, `
			INSERT INTO storage_deletion_queue (
				repository_id, owner_type, owner_id, allocation_key, object_key,
				size_bytes, delete_after
			) VALUES ($1, 'user', $2, $3, $4, 11, NOW())
		`, row.repositoryID, userID, row.allocationKey, row.objectKey)
		require.NoError(t, err)
	}

	wrongAllocation, err := q.ClearPurgedStorageDeletionByExactKey(ctx, ClearPurgedStorageDeletionByExactKeyParams{
		RepositoryID: repoID, AllocationKey: "workflow-artifact:99", ObjectKey: "pending/workflow-artifacts/exact",
	})
	require.NoError(t, err)
	assert.Zero(t, wrongAllocation)

	wrongRepository, err := q.ClearPurgedStorageDeletionByExactKey(ctx, ClearPurgedStorageDeletionByExactKeyParams{
		RepositoryID: otherRepoID, AllocationKey: "workflow-artifact:41", ObjectKey: "pending/workflow-artifacts/exact",
	})
	require.NoError(t, err)
	assert.Zero(t, wrongRepository)

	deleted, err := q.ClearPurgedStorageDeletionByExactKey(ctx, ClearPurgedStorageDeletionByExactKeyParams{
		RepositoryID: repoID, AllocationKey: "workflow-artifact:41", ObjectKey: "pending/workflow-artifacts/exact",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), deleted)
	assert.Equal(t, int64(2), queueCount(t, tx, repoID)+queueCount(t, tx, otherRepoID))
}

func TestStorageDeletionQueueLFSReservationToObjectHasNoDoubleBilling(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), "queue-lfs-transition")
	oid := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	_, err := tx.Exec(ctx, `
		INSERT INTO lfs_upload_reservations (repository_id, oid, size, expires_at)
		VALUES ($1, $2, 73, $3)
	`, repoID, oid, time.Now().Add(time.Hour))
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `
		INSERT INTO lfs_objects (repository_id, oid, size, gcs_path)
		VALUES ($1, $2, 73, $3)
	`, repoID, oid, "repos/"+itoa(repoID)+"/lfs/"+oid)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `DELETE FROM lfs_upload_reservations WHERE repository_id = $1 AND oid = $2`, repoID, oid)
	require.NoError(t, err)
	assert.Zero(t, queueCount(t, tx, repoID), "active object replaces its reservation allocation")
	usage, err := q.SumStorageBytesByOwner(ctx, SumStorageBytesByOwnerParams{OwnerType: "user", OwnerID: userID})
	require.NoError(t, err)
	assert.Equal(t, int64(73), usage)
}

func itoa(value int64) string {
	return fmt.Sprintf("%d", value)
}
