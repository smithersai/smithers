package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestRepoConnection_H_ErrorBranches(t *testing.T) {
	t.Run("connect nil invalid json and service error", func(t *testing.T) {
		handler := &RepoHandler{RepoConnectionService: &mockRepoConnectionRouteService{}}
		rec := httptest.NewRecorder()
		handler.ConnectRepo(rec, httptest.NewRequest(http.MethodPost, "/repo-connection", strings.NewReader(`{}`)))
		require.Equal(t, http.StatusUnauthorized, rec.Code)

		req := withAuth(httptest.NewRequest(http.MethodPost, "/repo-connection", strings.NewReader(`{}`)), 7, "alice")
		rec = httptest.NewRecorder()
		(&RepoHandler{}).ConnectRepo(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		req = withAuth(httptest.NewRequest(http.MethodPost, "/repo-connection", strings.NewReader(`{`)), 7, "alice")
		rec = httptest.NewRecorder()
		handler.ConnectRepo(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		handler.RepoConnectionService = &mockRepoConnectionRouteService{
			connectFn: func(context.Context, int64, string, string, string) (services.RepoConnection, error) {
				return services.RepoConnection{}, pkgerrors.BadRequest("license required")
			},
		}
		req = withAuth(httptest.NewRequest(http.MethodPost, "/repo-connection", strings.NewReader(`{"owner":"acme","repo":"demo"}`)), 7, "alice")
		rec = httptest.NewRecorder()
		handler.ConnectRepo(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		handler.RepoConnectionService = &mockRepoConnectionRouteService{
			connectFn: func(context.Context, int64, string, string, string) (services.RepoConnection, error) {
				return services.RepoConnection{Owner: "acme", Repo: "demo", LicenseSPDX: "MIT"}, nil
			},
		}
		req = withAuth(httptest.NewRequest(http.MethodPost, "/repo-connection", strings.NewReader(`{"owner":"acme","repo":"demo","license_spdx_id":"MIT"}`)), 7, "alice")
		rec = httptest.NewRecorder()
		handler.ConnectRepo(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("disconnect auth nil invalid json and service error", func(t *testing.T) {
		handler := &RepoHandler{RepoConnectionService: &mockRepoConnectionRouteService{}}
		rec := httptest.NewRecorder()
		handler.DisconnectRepo(rec, httptest.NewRequest(http.MethodDelete, "/repo-connection", nil))
		require.Equal(t, http.StatusUnauthorized, rec.Code)

		req := withAuth(httptest.NewRequest(http.MethodDelete, "/repo-connection", strings.NewReader(`{}`)), 7, "alice")
		rec = httptest.NewRecorder()
		(&RepoHandler{}).DisconnectRepo(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		req = withAuth(httptest.NewRequest(http.MethodDelete, "/repo-connection", strings.NewReader(`{`)), 7, "alice")
		rec = httptest.NewRecorder()
		handler.DisconnectRepo(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		handler.RepoConnectionService = &mockRepoConnectionRouteService{
			disconnectFn: func(context.Context, int64, string, string) (bool, error) {
				return false, pkgerrors.NotFound("not connected")
			},
		}
		req = withAuth(httptest.NewRequest(http.MethodDelete, "/repo-connection", strings.NewReader(`{"owner":"acme","repo":"demo"}`)), 7, "alice")
		rec = httptest.NewRecorder()
		handler.DisconnectRepo(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)

		handler.RepoConnectionService = &mockRepoConnectionRouteService{
			disconnectFn: func(context.Context, int64, string, string) (bool, error) {
				return true, nil
			},
		}
		req = withAuth(httptest.NewRequest(http.MethodDelete, "/repo-connection", strings.NewReader(`{"owner":" acme ","repo":" demo "}`)), 7, "alice")
		rec = httptest.NewRecorder()
		handler.DisconnectRepo(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("status and app status auth nil and route errors", func(t *testing.T) {
		handler := &RepoHandler{RepoConnectionService: &mockRepoConnectionRouteService{}}
		rec := httptest.NewRecorder()
		handler.RepoConnectionStatus(rec, httptest.NewRequest(http.MethodGet, "/repo-connection", nil))
		require.Equal(t, http.StatusUnauthorized, rec.Code)

		req := withAuth(httptest.NewRequest(http.MethodGet, "/repo-connection", nil), 7, "alice")
		rec = httptest.NewRecorder()
		(&RepoHandler{}).RepoConnectionStatus(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		rec = httptest.NewRecorder()
		handler.RepoConnectionStatus(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = withAuth(httptest.NewRequest(http.MethodGet, "/repo-connection?owner=acme", nil), 7, "alice")
		rec = httptest.NewRecorder()
		handler.RepoConnectionStatus(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		handler.RepoConnectionService = &mockRepoConnectionRouteService{
			statusFn: func(context.Context, int64, string, string) (services.RepoConnectionStatus, error) {
				return services.RepoConnectionStatus{}, pkgerrors.Forbidden("denied")
			},
		}
		req = withAuth(httptest.NewRequest(http.MethodGet, "/repo-connection?owner=acme&repo=demo", nil), 7, "alice")
		rec = httptest.NewRecorder()
		handler.RepoConnectionStatus(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)

		handler.RepoConnectionService = &mockRepoConnectionRouteService{
			statusFn: func(context.Context, int64, string, string) (services.RepoConnectionStatus, error) {
				return services.RepoConnectionStatus{Connected: true, Owner: "acme", Repo: "demo", LicenseSPDX: "MIT"}, nil
			},
		}
		rec = httptest.NewRecorder()
		handler.RepoConnectionStatus(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		rec = httptest.NewRecorder()
		handler.GitHubAppStatus(rec, httptest.NewRequest(http.MethodGet, "/repos/acme/demo/github-app-status", nil))
		require.Equal(t, http.StatusUnauthorized, rec.Code)

		req = withAuth(httptest.NewRequest(http.MethodGet, "/repos/acme/demo/github-app-status", nil), 7, "alice")
		rec = httptest.NewRecorder()
		(&RepoHandler{}).GitHubAppStatus(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		rec = httptest.NewRecorder()
		handler.GitHubAppStatus(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		handler.RepoConnectionService = &mockRepoConnectionRouteService{
			githubAppStatusFn: func(context.Context, int64, string, string) (services.GitHubAppStatus, error) {
				return services.GitHubAppStatus{GitHubAppInstalled: true, InstallationID: 99, InstallURL: "https://example/install", Owner: "acme", Repo: "demo"}, nil
			},
		}
		req = withAuth(httptest.NewRequest(http.MethodGet, "/repos/acme/demo/github-app-status", nil), 7, "alice")
		req = withRouteParams(req, map[string]string{"owner": "acme", "repo": "demo"})
		rec = httptest.NewRecorder()
		handler.GitHubAppStatus(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})
}
