package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockRepoConnectionRouteService struct {
	connectFn         func(ctx context.Context, userID int64, owner, repo, licenseSPDX string) (services.RepoConnection, error)
	disconnectFn      func(ctx context.Context, userID int64, owner, repo string) (bool, error)
	statusFn          func(ctx context.Context, userID int64, owner, repo string) (services.RepoConnectionStatus, error)
	githubAppStatusFn func(ctx context.Context, userID int64, owner, repo string) (services.GitHubAppStatus, error)
}

func (m *mockRepoConnectionRouteService) ConnectRepo(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
	licenseSPDX string,
) (services.RepoConnection, error) {
	if m.connectFn != nil {
		return m.connectFn(ctx, userID, owner, repo, licenseSPDX)
	}
	return services.RepoConnection{}, nil
}

func (m *mockRepoConnectionRouteService) DisconnectRepo(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
) (bool, error) {
	if m.disconnectFn != nil {
		return m.disconnectFn(ctx, userID, owner, repo)
	}
	return false, nil
}

func (m *mockRepoConnectionRouteService) GetRepoConnectionStatus(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
) (services.RepoConnectionStatus, error) {
	if m.statusFn != nil {
		return m.statusFn(ctx, userID, owner, repo)
	}
	return services.RepoConnectionStatus{}, nil
}

func (m *mockRepoConnectionRouteService) GetGitHubAppStatus(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
) (services.GitHubAppStatus, error) {
	if m.githubAppStatusFn != nil {
		return m.githubAppStatusFn(ctx, userID, owner, repo)
	}
	return services.GitHubAppStatus{}, nil
}

func TestRepoHandler_ConnectRepo(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 4, 4, 9, 0, 0, 0, time.UTC)
	h := &RepoHandler{
		RepoConnectionService: &mockRepoConnectionRouteService{
			connectFn: func(ctx context.Context, userID int64, owner, repo, licenseSPDX string) (services.RepoConnection, error) {
				assert.Equal(t, int64(5), userID)
				assert.Equal(t, "acme", owner)
				assert.Equal(t, "backend", repo)
				assert.Equal(t, "MIT", licenseSPDX)
				return services.RepoConnection{
					UserID:       userID,
					Owner:        owner,
					Repo:         repo,
					LicenseSPDX:  licenseSPDX,
					ConnectedAt:  now,
					LastSyncedAt: now,
				}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/repo-connection", strings.NewReader(`{"owner":"acme","repo":"backend","license_spdx_id":"MIT"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withAuth(req, 5, "alice")
	rec := httptest.NewRecorder()
	h.ConnectRepo(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var response RepoConnectionResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	assert.True(t, response.Connected)
	assert.Equal(t, "acme", response.Owner)
	assert.Equal(t, "backend", response.Repo)
	assert.Equal(t, "MIT", response.LicenseSPDX)
}

func TestRepoHandler_ConnectRepo_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &RepoHandler{RepoConnectionService: &mockRepoConnectionRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/repo-connection", strings.NewReader(`{"owner":"acme","repo":"backend","license_spdx_id":"MIT"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ConnectRepo(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestRepoHandler_DisconnectRepo(t *testing.T) {
	t.Parallel()

	h := &RepoHandler{
		RepoConnectionService: &mockRepoConnectionRouteService{
			disconnectFn: func(ctx context.Context, userID int64, owner, repo string) (bool, error) {
				assert.Equal(t, int64(9), userID)
				assert.Equal(t, "acme", owner)
				assert.Equal(t, "backend", repo)
				return true, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/repo-connection", strings.NewReader(`{"owner":"acme","repo":"backend"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withAuth(req, 9, "alice")
	rec := httptest.NewRecorder()
	h.DisconnectRepo(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var response RepoConnectionResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	assert.False(t, response.Connected)
	assert.Equal(t, "acme", response.Owner)
	assert.Equal(t, "backend", response.Repo)
}

func TestRepoHandler_RepoConnectionStatus(t *testing.T) {
	t.Parallel()

	h := &RepoHandler{
		RepoConnectionService: &mockRepoConnectionRouteService{
			statusFn: func(ctx context.Context, userID int64, owner, repo string) (services.RepoConnectionStatus, error) {
				assert.Equal(t, int64(3), userID)
				assert.Equal(t, "acme", owner)
				assert.Equal(t, "backend", repo)
				return services.RepoConnectionStatus{
					Connected:   true,
					Owner:       "acme",
					Repo:        "backend",
					LicenseSPDX: "MIT",
				}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/repo-connection?owner=acme&repo=backend", nil)
	req = withAuth(req, 3, "alice")
	rec := httptest.NewRecorder()
	h.RepoConnectionStatus(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var response RepoConnectionResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	assert.True(t, response.Connected)
	assert.Equal(t, "acme", response.Owner)
	assert.Equal(t, "backend", response.Repo)
	assert.Equal(t, "MIT", response.LicenseSPDX)
}

func TestRepoHandler_RepoConnectionStatus_ServiceError(t *testing.T) {
	t.Parallel()

	h := &RepoHandler{
		RepoConnectionService: &mockRepoConnectionRouteService{
			statusFn: func(ctx context.Context, userID int64, owner, repo string) (services.RepoConnectionStatus, error) {
				return services.RepoConnectionStatus{}, pkgerrors.Forbidden("permission denied")
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/repo-connection?owner=acme&repo=backend", nil)
	req = withAuth(req, 3, "alice")
	rec := httptest.NewRecorder()
	h.RepoConnectionStatus(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
}

func TestRepoHandler_GitHubAppStatus(t *testing.T) {
	t.Parallel()

	h := &RepoHandler{
		RepoConnectionService: &mockRepoConnectionRouteService{
			githubAppStatusFn: func(ctx context.Context, userID int64, owner, repo string) (services.GitHubAppStatus, error) {
				assert.Equal(t, int64(42), userID)
				assert.Equal(t, "acme", owner)
				assert.Equal(t, "backend", repo)
				return services.GitHubAppStatus{
					GitHubAppInstalled: true,
					InstallationID:     7777,
					InstallURL:         "https://github.com/apps/smithers-cloud/installations/new",
					Owner:              "acme",
					Repo:               "backend",
				}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/acme/backend/github-app-status", nil)
	req = withRouteParams(req, map[string]string{"owner": "acme", "repo": "backend"})
	req = withAuth(req, 42, "alice")
	rec := httptest.NewRecorder()
	h.GitHubAppStatus(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var response GitHubAppStatusResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	assert.True(t, response.GitHubAppInstalled)
	assert.Equal(t, int64(7777), response.InstallationID)
	assert.Equal(t, "acme", response.Owner)
	assert.Equal(t, "backend", response.Repo)
	assert.Contains(t, response.InstallURL, "installations/new")
}

func TestRepoHandler_GitHubAppStatus_ForwardsConfiguredFlag(t *testing.T) {
	t.Parallel()

	// The wire contract the multi client renders honest not-configured state
	// from: github_app_configured must survive the route DTO mapping (it was
	// silently dropped when first added service-side, 2026-07-14).
	h := &RepoHandler{
		RepoConnectionService: &mockRepoConnectionRouteService{
			githubAppStatusFn: func(ctx context.Context, userID int64, owner, repo string) (services.GitHubAppStatus, error) {
				return services.GitHubAppStatus{
					GitHubAppInstalled:  false,
					GitHubAppConfigured: false,
					InstallURL:          "",
					Owner:               "acme",
					Repo:                "backend",
				}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/acme/backend/github-app-status", nil)
	req = withRouteParams(req, map[string]string{"owner": "acme", "repo": "backend"})
	req = withAuth(req, 42, "alice")
	rec := httptest.NewRecorder()
	h.GitHubAppStatus(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var raw map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &raw))
	value, present := raw["github_app_configured"]
	require.True(t, present, "github_app_configured must be serialized even when false")
	assert.Equal(t, false, value)
}

func TestRepoHandler_GitHubAppStatus_ServiceError(t *testing.T) {
	t.Parallel()

	h := &RepoHandler{
		RepoConnectionService: &mockRepoConnectionRouteService{
			githubAppStatusFn: func(ctx context.Context, userID int64, owner, repo string) (services.GitHubAppStatus, error) {
				return services.GitHubAppStatus{}, pkgerrors.Forbidden("permission denied")
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/acme/backend/github-app-status", nil)
	req = withRouteParams(req, map[string]string{"owner": "acme", "repo": "backend"})
	req = withAuth(req, 42, "alice")
	rec := httptest.NewRecorder()
	h.GitHubAppStatus(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
}
