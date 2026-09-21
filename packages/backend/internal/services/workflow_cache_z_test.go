package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestWorkflowCache_Z_RestoreAndBeginSaveCleanupBranches(t *testing.T) {
	ctx := context.Background()
	run := workflowCacheHRun()
	cache := workflowCacheHCache("finalized")

	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		findWorkflowCacheForRestoreFn: func(context.Context, db.FindWorkflowCacheForRestoreParams) (db.WorkflowCache, error) {
			return cache, nil
		},
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, errors.New("delete failed")
		},
	}, &mockBlobStore{
		existsFn: func(context.Context, string) (bool, error) { return false, nil },
	}, WorkflowCacheConfig{})
	_, err := service.Restore(ctx, run, "npm", "")
	require.Equal(t, 500, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{}, &mockBlobStore{}, WorkflowCacheConfig{})
	_, err = service.BeginSave(ctx, run, "", "", 10)
	require.Equal(t, 400, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, pgx.ErrNoRows
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	_, err = service.BeginSave(ctx, run, "npm", "", 10)
	require.Equal(t, 404, apiStatus(t, err))

	expiredFinalized := workflowCacheHCache("finalized")
	expiredFinalized.ExpiresAt = time.Now().Add(-time.Hour)
	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		getWorkflowCacheByScopeVersionFn: func(context.Context, db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error) {
			return expiredFinalized, nil
		},
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, errors.New("delete failed")
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	_, err = service.BeginSave(ctx, run, "npm", "", 10)
	require.Equal(t, 500, apiStatus(t, err))

	liveFinalized := workflowCacheHCache("finalized")
	liveFinalized.ExpiresAt = time.Now().Add(time.Hour)
	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		getWorkflowCacheByScopeVersionFn: func(context.Context, db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error) {
			return liveFinalized, nil
		},
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, errors.New("delete failed")
		},
	}, &mockBlobStore{
		existsFn: func(context.Context, string) (bool, error) { return false, nil },
	}, WorkflowCacheConfig{})
	_, err = service.BeginSave(ctx, run, "npm", "", 10)
	require.Equal(t, 500, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		getWorkflowCacheByScopeVersionFn: func(context.Context, db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error) {
			c := workflowCacheHCache("finalized")
			c.ExpiresAt = time.Now().Add(time.Hour)
			return c, nil
		},
		upsertPendingWorkflowCacheFn: func(_ context.Context, arg db.UpsertPendingWorkflowCacheParams) (db.WorkflowCache, error) {
			c := workflowCacheHCache("pending")
			c.ObjectKey = arg.ObjectKey
			c.ObjectSizeBytes = arg.ObjectSizeBytes
			return c, nil
		},
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, nil
		},
	}, &mockBlobStore{
		existsFn: func(context.Context, string) (bool, error) { return false, nil },
		deleteFn: func(context.Context, string) error { return nil },
		signedUploadURLFn: func(context.Context, string, string, int64, time.Duration) (string, error) {
			return "https://upload", nil
		},
	}, WorkflowCacheConfig{})
	reservation, err := service.BeginSave(ctx, run, "npm", "", 10)
	require.NoError(t, err)
	require.Equal(t, "https://upload", reservation.UploadURL)

	expiredPending := workflowCacheHCache("pending")
	expiredPending.WorkflowRunID = pgtype.Int8{Int64: 999, Valid: true}
	expiredPending.ExpiresAt = time.Now().Add(-time.Hour)
	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		getWorkflowCacheByScopeVersionFn: func(context.Context, db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error) {
			return expiredPending, nil
		},
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, errors.New("delete failed")
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	_, err = service.BeginSave(ctx, run, "npm", "", 10)
	require.Equal(t, 500, apiStatus(t, err))
}

func TestWorkflowCache_Z_FinalizeAbortCleanupAndClearBranches(t *testing.T) {
	ctx := context.Background()
	run := workflowCacheHRun()
	pending := workflowCacheHCache("pending")

	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) { return pending, nil },
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, errors.New("delete metadata failed")
		},
	}, &mockBlobStore{
		statFn: func(context.Context, string) (blob.ObjectAttrs, error) { return blob.ObjectAttrs{Size: 11}, nil },
	}, WorkflowCacheConfig{})
	_, err := service.FinalizeSave(ctx, run, 9, 10)
	require.Equal(t, 500, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn:    func(context.Context, int64) (db.WorkflowCache, error) { return pending, nil },
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) { return db.WorkflowCache{}, nil },
	}, &mockBlobStore{
		statFn:   func(context.Context, string) (blob.ObjectAttrs, error) { return blob.ObjectAttrs{Size: 10}, nil },
		deleteFn: func(context.Context, string) error { return nil },
	}, WorkflowCacheConfig{ArchiveMaxBytes: 5})
	_, err = service.FinalizeSave(ctx, run, 9, 10)
	require.Equal(t, 400, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) { return pending, nil },
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, errors.New("delete failed")
		},
	}, &mockBlobStore{
		statFn: func(context.Context, string) (blob.ObjectAttrs, error) { return blob.ObjectAttrs{Size: 10}, nil },
	}, WorkflowCacheConfig{}, WithWorkflowCacheBillingPolicy(workflowCacheHBillingPolicy{storageErr: errors.New("billing failed")}))
	_, err = service.FinalizeSave(ctx, run, 9, 10)
	require.NoError(t, err)

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn:    func(context.Context, int64) (db.WorkflowCache, error) { return pending, nil },
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) { return db.WorkflowCache{}, nil },
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	require.NoError(t, service.AbortSave(ctx, run, 9))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		listWorkflowCacheRepositoryIDsFn: func(context.Context) ([]int64, error) { return []int64{7}, nil },
		getWorkflowCacheRepoUsageFn:      func(context.Context, int64) (int64, error) { return 0, errors.New("usage failed") },
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	err = service.Cleanup(ctx)
	require.Equal(t, 500, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		listWorkflowCachesForClearFn: func(context.Context, db.ListWorkflowCachesForClearParams) ([]db.WorkflowCache, error) {
			return []db.WorkflowCache{workflowCacheHCache("finalized")}, nil
		},
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, errors.New("delete failed")
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	_, err = service.Clear(ctx, 7, WorkflowCacheListFilter{})
	require.Equal(t, 500, apiStatus(t, err))
}

func TestWorkflowCache_Z_ScopeAndPolicyBranches(t *testing.T) {
	ctx := context.Background()

	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, errors.New("repo failed")
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{}).(*workflowCacheService)
	_, _, err := service.resolveWorkflowCacheScope(ctx, 7, "main")
	require.Equal(t, 500, apiStatus(t, err))

	expiredPending := workflowCacheHCache("pending")
	expiredPending.ExpiresAt = time.Now().Add(-time.Hour)
	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheRepoUsageFn: func(context.Context, int64) (int64, error) { return 0, nil },
		listWorkflowCacheEvictionCandidatesFn: func(context.Context, db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
			return []db.WorkflowCache{expiredPending}, nil
		},
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, errors.New("delete failed")
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{}).(*workflowCacheService)
	err = service.enforceRepositoryCachePolicy(ctx, 7, 0)
	require.Equal(t, 500, apiStatus(t, err))

	expiredFinalized := workflowCacheHCache("finalized")
	expiredFinalized.ExpiresAt = time.Now().Add(-time.Hour)
	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheRepoUsageFn: func(context.Context, int64) (int64, error) { return 200, nil },
		listWorkflowCacheEvictionCandidatesFn: func(context.Context, db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
			return []db.WorkflowCache{expiredFinalized}, nil
		},
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, errors.New("delete failed")
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{RepoQuotaBytes: 100}).(*workflowCacheService)
	err = service.enforceRepositoryCachePolicy(ctx, 7, 0)
	require.Equal(t, 500, apiStatus(t, err))

	freshPending := workflowCacheHCache("pending")
	freshPending.ExpiresAt = time.Now().Add(time.Hour)
	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheRepoUsageFn: func(context.Context, int64) (int64, error) { return 0, nil },
		listWorkflowCacheEvictionCandidatesFn: func(context.Context, db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
			return []db.WorkflowCache{freshPending}, nil
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{}).(*workflowCacheService)
	require.NoError(t, service.enforceRepositoryCachePolicy(ctx, 7, 0))
}
