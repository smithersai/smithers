package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockRepoSyncConnectionChecker struct {
	getRepoConnectionStatusFn func(ctx context.Context, userID int64, owner, repo string) (RepoConnectionStatus, error)
}

func (m *mockRepoSyncConnectionChecker) GetRepoConnectionStatus(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
) (RepoConnectionStatus, error) {
	if m.getRepoConnectionStatusFn != nil {
		return m.getRepoConnectionStatusFn(ctx, userID, owner, repo)
	}
	return RepoConnectionStatus{Connected: true}, nil
}

func TestRepoSyncService_SyncRepo_CreatesBareRepoAndMetadata(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	now := time.Date(2026, 4, 25, 12, 0, 0, 0, time.UTC)
	service := NewRepoSyncService(root, &mockRepoSyncConnectionChecker{})
	service.now = func() time.Time { return now }

	err := service.SyncRepo(context.Background(), 42, "Acme", "Demo", RepoSyncRequest{
		Bookmarks: []RepoSyncBookmark{
			{Name: "main", TargetChangeID: "chg-main", TargetCommitID: "c0ffee"},
			{Name: "feature", TargetChangeID: "chg-feature", TargetCommitID: "f00baa"},
		},
		WorkingCopyParent: RepoSyncWorkingCopyParent{
			ChangeID: "parent-change",
			CommitID: "parent-commit",
		},
	})
	require.NoError(t, err)

	repoPath := filepath.Join(root, "acme", "demo.git")
	headPath := filepath.Join(repoPath, "HEAD")
	metadataPath := filepath.Join(repoPath, "jj", "metadata.json")
	assert.FileExists(t, headPath)
	assert.FileExists(t, metadataPath)

	var metadata repoSyncMetadata
	data, readErr := os.ReadFile(metadataPath)
	require.NoError(t, readErr)
	require.NoError(t, json.Unmarshal(data, &metadata))
	assert.Equal(t, int64(42), metadata.UserID)
	assert.Equal(t, "acme", metadata.Owner)
	assert.Equal(t, "demo", metadata.Repo)
	assert.Equal(t, now, metadata.SyncedAt)
	require.Len(t, metadata.Bookmarks, 2)
	assert.Equal(t, "main", metadata.Bookmarks[0].Name)
	assert.Equal(t, "parent-change", metadata.WorkingCopyParent.ChangeID)
	assert.Equal(t, "parent-commit", metadata.WorkingCopyParent.CommitID)
}

func TestRepoSyncService_SyncRepo_UpdatesMetadataOnSubsequentSync(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	service := NewRepoSyncService(root, &mockRepoSyncConnectionChecker{})
	service.now = func() time.Time { return time.Date(2026, 4, 25, 13, 0, 0, 0, time.UTC) }

	require.NoError(t, service.SyncRepo(context.Background(), 42, "acme", "demo", RepoSyncRequest{
		Bookmarks: []RepoSyncBookmark{
			{Name: "main", TargetChangeID: "chg-main", TargetCommitID: "aaa"},
		},
		WorkingCopyParent: RepoSyncWorkingCopyParent{
			ChangeID: "change-1",
			CommitID: "commit-1",
		},
	}))

	service.now = func() time.Time { return time.Date(2026, 4, 25, 14, 0, 0, 0, time.UTC) }
	require.NoError(t, service.SyncRepo(context.Background(), 42, "acme", "demo", RepoSyncRequest{
		Bookmarks: []RepoSyncBookmark{
			{Name: "main", TargetChangeID: "chg-main-2", TargetCommitID: "bbb"},
		},
		WorkingCopyParent: RepoSyncWorkingCopyParent{
			ChangeID: "change-2",
			CommitID: "commit-2",
		},
	}))

	metadataPath := filepath.Join(root, "acme", "demo.git", "jj", "metadata.json")
	var metadata repoSyncMetadata
	data, err := os.ReadFile(metadataPath)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(data, &metadata))
	assert.Equal(t, "change-2", metadata.WorkingCopyParent.ChangeID)
	assert.Equal(t, "commit-2", metadata.WorkingCopyParent.CommitID)
	assert.Equal(t, "chg-main-2", metadata.Bookmarks[0].TargetChangeID)
	assert.Equal(t, "bbb", metadata.Bookmarks[0].TargetCommitID)
}

func TestRepoSyncService_SyncRepo_ValidatesInputs(t *testing.T) {
	t.Parallel()

	service := NewRepoSyncService(t.TempDir(), nil)

	err := service.SyncRepo(context.Background(), 0, "acme", "demo", RepoSyncRequest{
		WorkingCopyParent: RepoSyncWorkingCopyParent{CommitID: "abc"},
	})
	require.Error(t, err)
	assert.Equal(t, pkgerrors.Unauthorized("authentication required").Message, err.Error())

	err = service.SyncRepo(context.Background(), 1, "acme", "demo", RepoSyncRequest{})
	require.Error(t, err)
	assert.Equal(t, pkgerrors.BadRequest("working_copy_parent is required").Message, err.Error())

	err = service.SyncRepo(context.Background(), 1, "bad/name", "demo", RepoSyncRequest{
		WorkingCopyParent: RepoSyncWorkingCopyParent{CommitID: "abc"},
	})
	require.Error(t, err)
	assert.Equal(t, pkgerrors.BadRequest("owner contains invalid characters").Message, err.Error())

	err = service.SyncRepo(context.Background(), 1, "acme", "bad/name", RepoSyncRequest{
		WorkingCopyParent: RepoSyncWorkingCopyParent{CommitID: "abc"},
	})
	require.Error(t, err)
	assert.Equal(t, pkgerrors.BadRequest("repository name contains invalid characters").Message, err.Error())

	err = service.SyncRepo(context.Background(), 1, "acme", "demo", RepoSyncRequest{
		Bookmarks:         []RepoSyncBookmark{{Name: ""}},
		WorkingCopyParent: RepoSyncWorkingCopyParent{CommitID: "abc"},
	})
	require.Error(t, err)
	assert.Equal(t, pkgerrors.BadRequest("bookmark name is required").Message, err.Error())
}

func TestRepoSyncService_SyncRepo_RequiresRepoConnection(t *testing.T) {
	t.Parallel()

	var gotUserID int64
	var gotOwner string
	var gotRepo string
	service := NewRepoSyncService(t.TempDir(), &mockRepoSyncConnectionChecker{
		getRepoConnectionStatusFn: func(
			_ context.Context,
			userID int64,
			owner string,
			repo string,
		) (RepoConnectionStatus, error) {
			gotUserID = userID
			gotOwner = owner
			gotRepo = repo
			return RepoConnectionStatus{Connected: false}, nil
		},
	})

	err := service.SyncRepo(context.Background(), 77, "Acme", "Demo", RepoSyncRequest{
		WorkingCopyParent: RepoSyncWorkingCopyParent{CommitID: "abc"},
	})
	require.Error(t, err)
	assert.Equal(t, pkgerrors.Forbidden("repository is not connected").Message, err.Error())
	assert.Equal(t, int64(77), gotUserID)
	assert.Equal(t, "acme", gotOwner)
	assert.Equal(t, "demo", gotRepo)
}

func TestRepoSyncService_SyncRepo_PropagatesConnectionLookupErrors(t *testing.T) {
	t.Parallel()

	service := NewRepoSyncService(t.TempDir(), &mockRepoSyncConnectionChecker{
		getRepoConnectionStatusFn: func(
			_ context.Context,
			_ int64,
			_ string,
			_ string,
		) (RepoConnectionStatus, error) {
			return RepoConnectionStatus{}, pkgerrors.Internal("failed to load repo connection")
		},
	})

	err := service.SyncRepo(context.Background(), 7, "acme", "demo", RepoSyncRequest{
		WorkingCopyParent: RepoSyncWorkingCopyParent{CommitID: "abc"},
	})
	require.Error(t, err)
	assert.Equal(t, pkgerrors.Internal("failed to load repo connection").Message, err.Error())
}

func TestRepoSyncService_SyncRepo_RejectsWhenConnectionCheckerMissing(t *testing.T) {
	t.Parallel()

	service := NewRepoSyncService(t.TempDir(), nil)

	err := service.SyncRepo(context.Background(), 7, "acme", "demo", RepoSyncRequest{
		WorkingCopyParent: RepoSyncWorkingCopyParent{CommitID: "abc"},
	})
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.True(t, stdErrors.As(err, &apiErr))
	assert.Equal(t, pkgerrors.Internal("repo connection service not configured").Message, apiErr.Message)
}
