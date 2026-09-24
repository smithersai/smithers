package db

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWorkflowCachesSQL_H_CacheRoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	runID := workflowCachesSQLHCreateRun(t, q, repoID)
	expires := time.Now().Add(24 * time.Hour)

	pending := workflowCachesSQLHInsertCache(t, pool, repoID, runID, "main", "deps", "v1", "objects/one", "tar+gzip", "pending", 0, expires)
	assert.Equal(t, "pending", pending.Status)
	assert.Equal(t, "objects/one", pending.ObjectKey)
	_ = mustExpectError(t, pool, func(sp DBTX) error {
		_, updateErr := sp.Exec(ctx,
			`UPDATE workflow_caches SET deletion_token = 'invalid-live-token' WHERE id = $1`, pending.ID)
		return updateErr
	})

	pending, err := q.UpsertPendingWorkflowCache(ctx, UpsertPendingWorkflowCacheParams{
		RepositoryID: repoID, WorkflowRunID: runID, BookmarkName: "main", CacheKey: "deps", CacheVersion: "v1", ObjectKey: "objects/two", ObjectSizeBytes: 100, Compression: "zstd", ExpiresAt: expires,
	})
	require.NoError(t, err)
	assert.Equal(t, "pending", pending.Status)
	_, otherRepoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	otherRunID := workflowCachesSQLHCreateRun(t, q, otherRepoID)
	replacementRunID := workflowCachesSQLHCreateRun(t, q, repoID)
	_, err = q.UpsertPendingWorkflowCache(ctx, UpsertPendingWorkflowCacheParams{
		RepositoryID: repoID, WorkflowRunID: otherRunID, BookmarkName: "main", CacheKey: "wrong-run-repo",
		CacheVersion: "v1", ObjectKey: "objects/wrong-run-repo", ObjectSizeBytes: 1, Compression: "zstd", ExpiresAt: expires,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	byID, err := q.GetWorkflowCacheByID(ctx, pending.ID)
	require.NoError(t, err)
	assert.Equal(t, pending.ID, byID.ID)
	assert.Equal(t, "objects/two", byID.ObjectKey)
	assert.Equal(t, "zstd", byID.Compression)
	byScope, err := q.GetWorkflowCacheByScopeVersion(ctx, GetWorkflowCacheByScopeVersionParams{
		RepositoryID: repoID, BookmarkName: "main", CacheKey: "deps", CacheVersion: "v1",
	})
	require.NoError(t, err)
	assert.Equal(t, pending.ID, byScope.ID)

	// Finalize is a compare-and-swap on the exact reservation (issue 224):
	// a caller presenting the wrong run or object key must not claim the row.
	_, err = q.FinalizeWorkflowCache(ctx, FinalizeWorkflowCacheParams{
		ID: pending.ID, RepositoryID: repoID, WorkflowRunID: otherRunID, ObjectKey: "objects/two", ObjectSizeBytes: 100, ExpiresAt: expires,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.FinalizeWorkflowCache(ctx, FinalizeWorkflowCacheParams{
		ID: pending.ID, RepositoryID: repoID, WorkflowRunID: runID, ObjectKey: "objects/one", ObjectSizeBytes: 100, ExpiresAt: expires,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	mainCache, err := q.FinalizeWorkflowCache(ctx, FinalizeWorkflowCacheParams{
		ID: pending.ID, RepositoryID: repoID, WorkflowRunID: runID, ObjectKey: "objects/two", ObjectSizeBytes: 100, ExpiresAt: expires,
	})
	require.NoError(t, err)
	assert.Equal(t, "finalized", mainCache.Status)
	assert.Equal(t, int64(100), mainCache.ObjectSizeBytes)
	assert.True(t, mainCache.FinalizedAt.Valid)

	unchanged, err := q.UpsertPendingWorkflowCache(ctx, UpsertPendingWorkflowCacheParams{
		RepositoryID: repoID, BookmarkName: "main", CacheKey: "deps", CacheVersion: "v1", ObjectKey: "objects/ignored", Compression: "tar+gzip", ExpiresAt: expires,
	})
	require.NoError(t, err)
	assert.Equal(t, mainCache.ID, unchanged.ID)
	assert.Equal(t, "finalized", unchanged.Status)
	assert.Equal(t, "objects/two", unchanged.ObjectKey)

	feature := workflowCachesSQLHInsertCache(t, pool, repoID, runID, "feature", "deps", "v1", "objects/feature", "tar+gzip", "pending", 200, expires)
	feature, err = q.FinalizeWorkflowCache(ctx, FinalizeWorkflowCacheParams{
		ID: feature.ID, RepositoryID: repoID, WorkflowRunID: runID, ObjectKey: "objects/feature", ObjectSizeBytes: 200, ExpiresAt: expires,
	})
	require.NoError(t, err)

	restore, err := q.FindWorkflowCacheForRestore(ctx, FindWorkflowCacheForRestoreParams{
		RepositoryID: repoID, CacheKey: "deps", CacheVersion: "v1", BookmarkName: "feature", DefaultBookmark: "main",
	})
	require.NoError(t, err)
	assert.Equal(t, feature.ID, restore.ID)
	restore, err = q.FindWorkflowCacheForRestore(ctx, FindWorkflowCacheForRestoreParams{
		RepositoryID: repoID, CacheKey: "deps", CacheVersion: "v1", BookmarkName: "missing", DefaultBookmark: "main",
	})
	require.NoError(t, err)
	assert.Equal(t, mainCache.ID, restore.ID)

	require.NoError(t, q.TouchWorkflowCacheHit(ctx, feature.ID))
	feature, err = q.GetWorkflowCacheByID(ctx, feature.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), feature.HitCount)
	assert.True(t, feature.LastHitAt.Valid)

	usage, err := q.GetWorkflowCacheRepoUsage(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, int64(300), usage)
	stats, err := q.GetWorkflowCacheStats(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), stats.CacheCount)
	assert.Equal(t, int64(300), stats.TotalSizeBytes)

	// Deletion is a two-phase exact claim. While claimed, finalize/upsert are
	// excluded and finalized bytes remain in repository usage until physical
	// deletion completes and the token holder removes metadata.
	deleting := workflowCachesSQLHInsertCache(t, pool, repoID, runID, "delete", "deps", "v1", "objects/delete", "tar+gzip", "pending", 0, expires)
	deleteToken := pgtype.Text{String: "delete-token", Valid: true}
	_, err = q.ClaimWorkflowCacheDeletion(ctx, ClaimWorkflowCacheDeletionParams{
		DeletionToken: deleteToken, ID: deleting.ID, RepositoryID: repoID,
		WorkflowRunID: otherRunID, ObjectKey: deleting.ObjectKey, ExpectedStatus: "pending",
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	claimed, err := q.ClaimWorkflowCacheDeletion(ctx, ClaimWorkflowCacheDeletionParams{
		DeletionToken: deleteToken, ID: deleting.ID, RepositoryID: repoID,
		WorkflowRunID: runID, ObjectKey: deleting.ObjectKey, ExpectedStatus: "pending",
	})
	require.NoError(t, err)
	assert.Equal(t, "deleting", claimed.Status)
	assert.Equal(t, deleteToken, claimed.DeletionToken)

	blocked, err := q.UpsertPendingWorkflowCache(ctx, UpsertPendingWorkflowCacheParams{
		RepositoryID: repoID, WorkflowRunID: replacementRunID, BookmarkName: "delete", CacheKey: "deps",
		CacheVersion: "v1", ObjectKey: "objects/reassigned", Compression: "zstd", ExpiresAt: expires,
	})
	require.NoError(t, err)
	assert.Equal(t, "deleting", blocked.Status)
	assert.Equal(t, deleting.ObjectKey, blocked.ObjectKey)
	_, err = q.FinalizeWorkflowCache(ctx, FinalizeWorkflowCacheParams{
		ID: deleting.ID, RepositoryID: repoID, WorkflowRunID: runID, ObjectKey: deleting.ObjectKey,
		ObjectSizeBytes: 1, ExpiresAt: expires,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	require.NoError(t, q.ReleaseWorkflowCacheDeletionClaim(ctx, ReleaseWorkflowCacheDeletionClaimParams{
		ID: deleting.ID, RepositoryID: repoID, WorkflowRunID: runID,
		ObjectKey: deleting.ObjectKey, DeletionToken: deleteToken,
	}))
	retryToken := pgtype.Text{String: "retry-token", Valid: true}
	retried, err := q.RetryWorkflowCacheDeletion(ctx, RetryWorkflowCacheDeletionParams{
		DeletionToken: retryToken, ID: deleting.ID, RepositoryID: repoID,
		WorkflowRunID: runID, ObjectKey: deleting.ObjectKey,
	})
	require.NoError(t, err)
	assert.Equal(t, retryToken, retried.DeletionToken)
	deletedClaim, err := q.DeleteClaimedWorkflowCache(ctx, DeleteClaimedWorkflowCacheParams{
		ID: deleting.ID, RepositoryID: repoID, WorkflowRunID: runID,
		ObjectKey: deleting.ObjectKey, DeletionToken: retryToken,
	})
	require.NoError(t, err)
	assert.Equal(t, deleting.ID, deletedClaim.ID)
	_, err = q.GetWorkflowCacheByID(ctx, deleting.ID)
	require.ErrorIs(t, err, pgx.ErrNoRows)

	pendingOther := workflowCachesSQLHInsertCache(t, pool, repoID, runID, "main", "build", "v1", "objects/build", "tar+gzip", "pending", 1, expires)
	mustExec(t, pool, `UPDATE workflow_caches SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, pendingOther.ID)

	// An expired reservation can no longer be finalized, even by its owner.
	_, err = q.FinalizeWorkflowCache(ctx, FinalizeWorkflowCacheParams{
		ID: pendingOther.ID, RepositoryID: repoID, WorkflowRunID: runID, ObjectKey: "objects/build", ObjectSizeBytes: 1, ExpiresAt: expires,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	repos, err := q.ListWorkflowCacheRepositoryIDs(ctx)
	require.NoError(t, err)
	assert.Contains(t, repos, repoID)
	caches, err := q.ListWorkflowCaches(ctx, ListWorkflowCachesParams{RepositoryID: repoID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, caches, 2)
	filtered, err := q.ListWorkflowCaches(ctx, ListWorkflowCachesParams{RepositoryID: repoID, BookmarkName: "feature", CacheKey: "deps", PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, filtered, 1)
	assert.Equal(t, feature.ID, filtered[0].ID)
	forClear, err := q.ListWorkflowCachesForClear(ctx, ListWorkflowCachesForClearParams{RepositoryID: repoID, BookmarkName: "", CacheKey: "deps"})
	require.NoError(t, err)
	require.Len(t, forClear, 2)
	eviction, err := q.ListWorkflowCacheEvictionCandidates(ctx, ListWorkflowCacheEvictionCandidatesParams{RepositoryID: repoID, LimitCount: 10})
	require.NoError(t, err)
	require.Len(t, eviction, 3)

	deleted, err := q.DeleteWorkflowCacheByID(ctx, feature.ID)
	require.NoError(t, err)
	assert.Equal(t, feature.ID, deleted.ID)
	_, err = q.GetWorkflowCacheByID(ctx, feature.ID)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.DeleteWorkflowCacheByID(ctx, feature.ID)
	require.ErrorIs(t, err, pgx.ErrNoRows)

	_, err = q.GetWorkflowCacheByID(ctx, 999999)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetWorkflowCacheByScopeVersion(ctx, GetWorkflowCacheByScopeVersionParams{RepositoryID: repoID, BookmarkName: "missing", CacheKey: "missing", CacheVersion: "v1"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.FinalizeWorkflowCache(ctx, FinalizeWorkflowCacheParams{ID: 999999, RepositoryID: repoID, WorkflowRunID: runID, ObjectKey: "objects/none", ObjectSizeBytes: 1, ExpiresAt: expires})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.FindWorkflowCacheForRestore(ctx, FindWorkflowCacheForRestoreParams{RepositoryID: repoID, CacheKey: "missing", CacheVersion: "v1", BookmarkName: "main", DefaultBookmark: "main"})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	empty, err := q.ListWorkflowCaches(ctx, ListWorkflowCachesParams{RepositoryID: 999999, PageSize: 10})
	require.NoError(t, err)
	assert.Empty(t, empty)
	zeroUsage, err := q.GetWorkflowCacheRepoUsage(ctx, 999999)
	require.NoError(t, err)
	assert.Zero(t, zeroUsage)

	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.UpsertPendingWorkflowCache(ctx, UpsertPendingWorkflowCacheParams{
			RepositoryID: 999999, BookmarkName: "main", CacheKey: "bad", CacheVersion: "v1", ObjectKey: "bad", Compression: "tar", ExpiresAt: expires,
		})
		return err
	})
	checkPending := workflowCachesSQLHInsertCache(t, pool, repoID, runID, "main", "chk", "v1", "objects/chk", "tar+gzip", "pending", 0, expires)
	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.FinalizeWorkflowCache(ctx, FinalizeWorkflowCacheParams{
			ID: checkPending.ID, RepositoryID: repoID, WorkflowRunID: runID, ObjectKey: "objects/chk", ObjectSizeBytes: -1, ExpiresAt: expires,
		})
		return err
	})

	require.NoError(t, q.TouchWorkflowCacheHit(ctx, 999999))
}

func TestWorkflowCachesSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("workflow caches h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListWorkflowCacheEvictionCandidates", func(q *Queries) error {
			_, err := q.ListWorkflowCacheEvictionCandidates(context.Background(), ListWorkflowCacheEvictionCandidatesParams{RepositoryID: 1, LimitCount: 1})
			return err
		}},
		{"ListWorkflowCacheRepositoryIDs", func(q *Queries) error {
			_, err := q.ListWorkflowCacheRepositoryIDs(context.Background())
			return err
		}},
		{"ListWorkflowCaches", func(q *Queries) error {
			_, err := q.ListWorkflowCaches(context.Background(), ListWorkflowCachesParams{RepositoryID: 1, PageSize: 1})
			return err
		}},
		{"ListWorkflowCachesForClear", func(q *Queries) error {
			_, err := q.ListWorkflowCachesForClear(context.Background(), ListWorkflowCachesForClearParams{RepositoryID: 1})
			return err
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			err := tc.call(New(workflowCachesSQLHDB{queryErr: sentinel}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			err := tc.call(New(workflowCachesSQLHDB{rows: &workflowCachesSQLHRows{next: true, scanErr: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			err := tc.call(New(workflowCachesSQLHDB{rows: &workflowCachesSQLHRows{err: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
	}
}

func TestWorkflowCachesSQL_H_QueryRowErrorBranches(t *testing.T) {
	sentinel := errors.New("workflow caches h row failed")
	q := New(workflowCachesSQLHDB{row: workflowCachesSQLHRow{err: sentinel}})

	_, err := q.DeleteWorkflowCacheByID(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
	_, err = q.ClaimWorkflowCacheDeletion(context.Background(), ClaimWorkflowCacheDeletionParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.DeleteClaimedWorkflowCache(context.Background(), DeleteClaimedWorkflowCacheParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.FinalizeWorkflowCache(context.Background(), FinalizeWorkflowCacheParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.FindWorkflowCacheForRestore(context.Background(), FindWorkflowCacheForRestoreParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.GetWorkflowCacheByID(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
	_, err = q.GetWorkflowCacheByScopeVersion(context.Background(), GetWorkflowCacheByScopeVersionParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.GetWorkflowCacheRepoUsage(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
	_, err = q.GetWorkflowCacheStats(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
	_, err = q.UpsertPendingWorkflowCache(context.Background(), UpsertPendingWorkflowCacheParams{WorkflowRunID: pgtype.Int8{}})
	require.ErrorIs(t, err, sentinel)
	_, err = q.RetryWorkflowCacheDeletion(context.Background(), RetryWorkflowCacheDeletionParams{})
	require.ErrorIs(t, err, sentinel)
}

func TestWorkflowCachesSQL_H_ExecErrorBranches(t *testing.T) {
	sentinel := errors.New("workflow caches h exec failed")
	q := New(workflowCachesSQLHDB{execErr: sentinel})
	require.ErrorIs(t, q.TouchWorkflowCacheHit(context.Background(), 1), sentinel)
	require.ErrorIs(t, q.ReleaseWorkflowCacheDeletionClaim(context.Background(), ReleaseWorkflowCacheDeletionClaimParams{}), sentinel)
}

func workflowCachesSQLHCreateRun(t *testing.T, q *Queries, repoID int64) pgtype.Int8 {
	t.Helper()
	def, err := q.UpsertWorkflowDefinition(context.Background(), UpsertWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Caches H",
		Path:         ".smithers/workflows/caches-h-" + randSlug(t) + ".yml",
		Config:       json.RawMessage(`{}`),
	})
	require.NoError(t, err)
	run, err := q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "running",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "sha-caches-h",
		DispatchInputs:       []byte(`{}`),
	})
	require.NoError(t, err)
	return pgtype.Int8{Int64: run.ID, Valid: true}
}

func workflowCachesSQLHInsertCache(t *testing.T, pool DBTX, repoID int64, workflowRunID pgtype.Int8, bookmark, cacheKey, version, objectKey, compression, status string, size int64, expires time.Time) WorkflowCach {
	t.Helper()
	var cache WorkflowCach
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO workflow_caches (
			repository_id, workflow_run_id, bookmark_name, cache_key, cache_version, object_key, compression, status, object_size_bytes, finalized_at, expires_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::varchar(16), $9, CASE WHEN $8::varchar(16) = 'finalized' THEN NOW() ELSE NULL END, $10)
		RETURNING id, repository_id, workflow_run_id, bookmark_name, cache_key, cache_version, object_key, object_size_bytes, compression, status, hit_count, last_hit_at, finalized_at, expires_at, created_at, updated_at`,
		repoID,
		workflowRunID,
		bookmark,
		cacheKey,
		version,
		objectKey,
		compression,
		status,
		size,
		expires,
	).Scan(
		&cache.ID,
		&cache.RepositoryID,
		&cache.WorkflowRunID,
		&cache.BookmarkName,
		&cache.CacheKey,
		&cache.CacheVersion,
		&cache.ObjectKey,
		&cache.ObjectSizeBytes,
		&cache.Compression,
		&cache.Status,
		&cache.HitCount,
		&cache.LastHitAt,
		&cache.FinalizedAt,
		&cache.ExpiresAt,
		&cache.CreatedAt,
		&cache.UpdatedAt,
	)
	require.NoError(t, err)
	return cache
}

type workflowCachesSQLHDB struct {
	execErr  error
	queryErr error
	rows     pgx.Rows
	row      pgx.Row
}

func (db workflowCachesSQLHDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, db.execErr
}

func (db workflowCachesSQLHDB) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	if db.queryErr != nil {
		return nil, db.queryErr
	}
	if db.rows != nil {
		return db.rows, nil
	}
	return &workflowCachesSQLHRows{}, nil
}

func (db workflowCachesSQLHDB) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	if db.row != nil {
		return db.row
	}
	return workflowCachesSQLHRow{err: errors.New("workflow caches h row failed")}
}

type workflowCachesSQLHRow struct {
	err error
}

func (r workflowCachesSQLHRow) Scan(...any) error {
	return r.err
}

type workflowCachesSQLHRows struct {
	next    bool
	scanErr error
	err     error
}

func (r *workflowCachesSQLHRows) Close() {}

func (r *workflowCachesSQLHRows) Err() error {
	return r.err
}

func (r *workflowCachesSQLHRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r *workflowCachesSQLHRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}

func (r *workflowCachesSQLHRows) Next() bool {
	if r.next {
		r.next = false
		return true
	}
	return false
}

func (r *workflowCachesSQLHRows) Scan(...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	return errors.New("workflow caches h scan unexpectedly succeeded")
}

func (r *workflowCachesSQLHRows) Values() ([]any, error) {
	return nil, r.err
}

func (r *workflowCachesSQLHRows) RawValues() [][]byte {
	return nil
}

func (r *workflowCachesSQLHRows) Conn() *pgx.Conn {
	return nil
}
