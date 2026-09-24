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

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockDeployKeyRouteService struct {
	listDeployKeysFn  func(ctx context.Context, owner, repo string) ([]services.DeployKeyResponse, error)
	createDeployKeyFn func(ctx context.Context, owner, repo string, req services.CreateDeployKeyRequest) (services.DeployKeyResponse, error)
	deleteDeployKeyFn func(ctx context.Context, owner, repo string, keyID int64) error
}

func (m *mockDeployKeyRouteService) ListDeployKeys(ctx context.Context, owner, repo string) ([]services.DeployKeyResponse, error) {
	if m.listDeployKeysFn != nil {
		return m.listDeployKeysFn(ctx, owner, repo)
	}
	return nil, nil
}

func (m *mockDeployKeyRouteService) CreateDeployKey(ctx context.Context, owner, repo string, req services.CreateDeployKeyRequest) (services.DeployKeyResponse, error) {
	if m.createDeployKeyFn != nil {
		return m.createDeployKeyFn(ctx, owner, repo, req)
	}
	return services.DeployKeyResponse{}, nil
}

func (m *mockDeployKeyRouteService) DeleteDeployKey(ctx context.Context, owner, repo string, keyID int64) error {
	if m.deleteDeployKeyFn != nil {
		return m.deleteDeployKeyFn(ctx, owner, repo, keyID)
	}
	return nil
}

func TestDeployKeyHandler_ListDeployKeys(t *testing.T) {
	t.Parallel()

	h := &DeployKeyHandler{Service: &mockDeployKeyRouteService{
		listDeployKeysFn: func(ctx context.Context, owner, repo string) ([]services.DeployKeyResponse, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			return []services.DeployKeyResponse{
				{ID: 1, Title: "ci-key", KeyFingerprint: "SHA256:abc123", ReadOnly: true},
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/keys", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()
	h.ListDeployKeys(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var keys []services.DeployKeyResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &keys))
	assert.Len(t, keys, 1)
	assert.Equal(t, "ci-key", keys[0].Title)
}

func TestDeployKeyHandler_CreateDeployKey_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &DeployKeyHandler{Service: &mockDeployKeyRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/keys", strings.NewReader(`{"title":"k","key":"ssh-ed25519 AAAA"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()
	h.CreateDeployKey(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestDeployKeyHandler_CreateDeployKey_Success(t *testing.T) {
	t.Parallel()

	h := &DeployKeyHandler{
		Service: &mockDeployKeyRouteService{
			createDeployKeyFn: func(ctx context.Context, owner, repo string, req services.CreateDeployKeyRequest) (services.DeployKeyResponse, error) {
				assert.Equal(t, "deploy-key", req.Title)
				return services.DeployKeyResponse{ID: 42, Title: "deploy-key", KeyFingerprint: "SHA256:xyz"}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/keys", strings.NewReader(`{"title":"deploy-key","key":"ssh-ed25519 AAAA","read_only":true}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.CreateDeployKey(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	var key services.DeployKeyResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &key))
	assert.Equal(t, int64(42), key.ID)
}

func TestDeployKeyHandler_DeleteDeployKey_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &DeployKeyHandler{Service: &mockDeployKeyRouteService{}}
	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/keys/1", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "1"})
	rec := httptest.NewRecorder()
	h.DeleteDeployKey(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestDeployKeyHandler_DeleteDeployKey_Success(t *testing.T) {
	t.Parallel()

	deleteCalled := false
	h := &DeployKeyHandler{
		Service: &mockDeployKeyRouteService{
			deleteDeployKeyFn: func(ctx context.Context, owner, repo string, keyID int64) error {
				deleteCalled = true
				assert.Equal(t, int64(42), keyID)
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/keys/42", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "42"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.DeleteDeployKey(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.True(t, deleteCalled)
}

func TestDeployKeyHandler_DeleteDeployKey_InvalidID(t *testing.T) {
	t.Parallel()

	h := &DeployKeyHandler{Service: &mockDeployKeyRouteService{}}
	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/keys/invalid", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "invalid"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.DeleteDeployKey(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestDeployKeyHandler_ListDeployKeys_ServiceError(t *testing.T) {
	t.Parallel()

	h := &DeployKeyHandler{Service: &mockDeployKeyRouteService{
		listDeployKeysFn: func(ctx context.Context, owner, repo string) ([]services.DeployKeyResponse, error) {
			return nil, pkgerrors.NotFound("repository")
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/missing/keys", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "missing"})
	rec := httptest.NewRecorder()
	h.ListDeployKeys(rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)
}
