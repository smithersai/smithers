package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockRepoSyncRouteService struct {
	syncFn func(ctx context.Context, userID int64, owner, repo string, req services.RepoSyncRequest) error
}

func (m *mockRepoSyncRouteService) SyncRepo(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
	req services.RepoSyncRequest,
) error {
	if m.syncFn != nil {
		return m.syncFn(ctx, userID, owner, repo, req)
	}
	return nil
}

func TestRepoHandler_SyncRepo(t *testing.T) {
	t.Parallel()

	h := &RepoHandler{
		RepoSyncService: &mockRepoSyncRouteService{
			syncFn: func(ctx context.Context, userID int64, owner, repo string, req services.RepoSyncRequest) error {
				assert.Equal(t, int64(77), userID)
				assert.Equal(t, "acme", owner)
				assert.Equal(t, "demo", repo)
				require.Len(t, req.Bookmarks, 1)
				assert.Equal(t, "main", req.Bookmarks[0].Name)
				assert.Equal(t, "parent-change", req.WorkingCopyParent.ChangeID)
				assert.Equal(t, "parent-commit", req.WorkingCopyParent.CommitID)
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/demo/sync", strings.NewReader(`{
		"bookmarks":[{"name":"main","target_change_id":"chg-main","target_commit_id":"abc"}],
		"working_copy_parent":{"change_id":"parent-change","commit_id":"parent-commit"}
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"owner": "acme", "repo": "demo"})
	req = withAuth(req, 77, "alice")
	rec := httptest.NewRecorder()

	h.SyncRepo(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var response RepoSyncResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	assert.True(t, response.Synced)
	assert.Equal(t, "acme", response.Owner)
	assert.Equal(t, "demo", response.Repo)
}

func TestRepoHandler_SyncRepo_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &RepoHandler{RepoSyncService: &mockRepoSyncRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/demo/sync", strings.NewReader(`{
		"bookmarks":[{"name":"main"}],
		"working_copy_parent":{"commit_id":"abc"}
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"owner": "acme", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.SyncRepo(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestRepoHandler_SyncRepo_ServiceError(t *testing.T) {
	t.Parallel()

	h := &RepoHandler{
		RepoSyncService: &mockRepoSyncRouteService{
			syncFn: func(ctx context.Context, userID int64, owner, repo string, req services.RepoSyncRequest) error {
				return pkgerrors.Forbidden("permission denied")
			},
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/demo/sync", strings.NewReader(`{
		"bookmarks":[{"name":"main"}],
		"working_copy_parent":{"commit_id":"abc"}
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"owner": "acme", "repo": "demo"})
	req = withAuth(req, 77, "alice")
	rec := httptest.NewRecorder()

	h.SyncRepo(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
}
