package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestDeployKeys_Cov_CreateAndDeleteServiceErrors(t *testing.T) {
	t.Parallel()

	t.Run("create invalid json", func(t *testing.T) {
		t.Parallel()

		h := &DeployKeyHandler{Service: &mockDeployKeyRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/keys", strings.NewReader(`{`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.CreateDeployKey(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("create service error", func(t *testing.T) {
		t.Parallel()

		h := &DeployKeyHandler{Service: &mockDeployKeyRouteService{
			createDeployKeyFn: func(context.Context, string, string, services.CreateDeployKeyRequest) (services.DeployKeyResponse, error) {
				return services.DeployKeyResponse{}, pkgerrors.Conflict("deploy key already exists")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/keys", strings.NewReader(`{"title":"k","key":"ssh-ed25519 AAAA","read_only":true}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.CreateDeployKey(rec, req)

		require.Equal(t, http.StatusConflict, rec.Code)
		assert.Contains(t, rec.Body.String(), "deploy key already exists")
	})

	t.Run("delete service error", func(t *testing.T) {
		t.Parallel()

		h := &DeployKeyHandler{Service: &mockDeployKeyRouteService{
			deleteDeployKeyFn: func(context.Context, string, string, int64) error {
				return pkgerrors.Forbidden("permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/keys/9", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "9"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.DeleteDeployKey(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})
}

func TestDeployKeys_Cov_RouteParamErrors(t *testing.T) {
	t.Parallel()

	t.Run("list missing owner", func(t *testing.T) {
		t.Parallel()

		h := &DeployKeyHandler{Service: &mockDeployKeyRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos//demo/keys", nil)
		req = withRouteParams(req, map[string]string{"repo": "demo"})
		rec := httptest.NewRecorder()

		h.ListDeployKeys(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete missing id", func(t *testing.T) {
		t.Parallel()

		h := &DeployKeyHandler{Service: &mockDeployKeyRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/keys/", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.DeleteDeployKey(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "deploy key id is required")
	})
}
