package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockSSHKeyRouteService struct {
	listKeysFn   func(ctx context.Context, userID int64) ([]services.SSHKeyResponse, error)
	getKeyByIDFn func(ctx context.Context, userID, keyID int64) (services.SSHKeyResponse, error)
	createKeyFn  func(ctx context.Context, userID int64, req services.CreateSSHKeyRequest) (services.SSHKeyResponse, error)
	deleteKeyFn  func(ctx context.Context, userID, keyID int64) error
}

func (m mockSSHKeyRouteService) ListKeys(ctx context.Context, userID int64) ([]services.SSHKeyResponse, error) {
	if m.listKeysFn != nil {
		return m.listKeysFn(ctx, userID)
	}
	return nil, nil
}

func (m mockSSHKeyRouteService) GetKeyByID(ctx context.Context, userID, keyID int64) (services.SSHKeyResponse, error) {
	if m.getKeyByIDFn != nil {
		return m.getKeyByIDFn(ctx, userID, keyID)
	}
	return services.SSHKeyResponse{}, nil
}

func (m mockSSHKeyRouteService) CreateKey(ctx context.Context, userID int64, req services.CreateSSHKeyRequest) (services.SSHKeyResponse, error) {
	if m.createKeyFn != nil {
		return m.createKeyFn(ctx, userID, req)
	}
	return services.SSHKeyResponse{}, nil
}

func (m mockSSHKeyRouteService) DeleteKey(ctx context.Context, userID, keyID int64) error {
	if m.deleteKeyFn != nil {
		return m.deleteKeyFn(ctx, userID, keyID)
	}
	return nil
}

func TestSSHKeyHandler_ListSSHKeys_Unauthorized(t *testing.T) {
	t.Parallel()

	handler := SSHKeyHandler{Service: mockSSHKeyRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/user/keys", nil)
	rec := httptest.NewRecorder()

	handler.ListSSHKeys(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestSSHKeyHandler_ListSSHKeys_Success(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC().Truncate(time.Second)
	handler := SSHKeyHandler{
		Service: mockSSHKeyRouteService{
			listKeysFn: func(ctx context.Context, userID int64) ([]services.SSHKeyResponse, error) {
				assert.Equal(t, int64(7), userID)
				return []services.SSHKeyResponse{{
					ID:          1,
					Name:        "laptop",
					Fingerprint: "SHA256:abc",
					KeyType:     "ssh-ed25519",
					CreatedAt:   now,
				}}, nil
			},
		},
	}

	req := withSSHKeyAuth(httptest.NewRequest(http.MethodGet, "/api/user/keys", nil), 7)
	rec := httptest.NewRecorder()

	handler.ListSSHKeys(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var payload []services.SSHKeyResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	require.Len(t, payload, 1)
	assert.Equal(t, int64(1), payload[0].ID)
}

func TestSSHKeyHandler_GetSSHKey_InvalidID(t *testing.T) {
	t.Parallel()

	handler := SSHKeyHandler{Service: mockSSHKeyRouteService{}}
	for _, rawID := range []string{"abc", "0", "-1"} {
		t.Run(rawID, func(t *testing.T) {
			req := withSSHKeyAuth(withSSHKeyRouteParam(httptest.NewRequest(http.MethodGet, "/api/user/keys/"+rawID, nil), rawID), 1)
			rec := httptest.NewRecorder()
			handler.GetSSHKey(rec, req)
			require.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}
}

func TestSSHKeyHandler_GetSSHKey_Unauthorized(t *testing.T) {
	t.Parallel()

	handler := SSHKeyHandler{Service: mockSSHKeyRouteService{}}
	req := withSSHKeyRouteParam(httptest.NewRequest(http.MethodGet, "/api/user/keys/1", nil), "1")
	rec := httptest.NewRecorder()

	handler.GetSSHKey(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestSSHKeyHandler_GetSSHKey_Success(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC().Truncate(time.Second)
	handler := SSHKeyHandler{
		Service: mockSSHKeyRouteService{
			getKeyByIDFn: func(ctx context.Context, userID, keyID int64) (services.SSHKeyResponse, error) {
				assert.Equal(t, int64(5), userID)
				assert.Equal(t, int64(12), keyID)
				return services.SSHKeyResponse{
					ID:          keyID,
					Name:        "laptop",
					Fingerprint: "SHA256:def",
					KeyType:     "ssh-ed25519",
					CreatedAt:   now,
				}, nil
			},
		},
	}

	req := withSSHKeyAuth(withSSHKeyRouteParam(httptest.NewRequest(http.MethodGet, "/api/user/keys/12", nil), "12"), 5)
	rec := httptest.NewRecorder()

	handler.GetSSHKey(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var payload services.SSHKeyResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, int64(12), payload.ID)
}

func TestSSHKeyHandler_CreateSSHKey_InvalidJSON(t *testing.T) {
	t.Parallel()

	handler := SSHKeyHandler{Service: mockSSHKeyRouteService{}}
	req := withSSHKeyAuth(httptest.NewRequest(http.MethodPost, "/api/user/keys", strings.NewReader("not-json")), 1)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.CreateSSHKey(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestSSHKeyHandler_CreateSSHKey_Unauthorized(t *testing.T) {
	t.Parallel()

	handler := SSHKeyHandler{Service: mockSSHKeyRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/user/keys", strings.NewReader(`{"title":"laptop","key":"ssh-ed25519 AAAA"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.CreateSSHKey(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestSSHKeyHandler_CreateSSHKey_Success201(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC().Truncate(time.Second)
	handler := SSHKeyHandler{
		Service: mockSSHKeyRouteService{
			createKeyFn: func(ctx context.Context, userID int64, req services.CreateSSHKeyRequest) (services.SSHKeyResponse, error) {
				assert.Equal(t, int64(3), userID)
				assert.Equal(t, "work-laptop", req.Title)
				assert.Equal(t, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP8example", req.Key)
				return services.SSHKeyResponse{
					ID:          99,
					Name:        "work-laptop",
					Fingerprint: "SHA256:xyz",
					KeyType:     "ssh-ed25519",
					CreatedAt:   now,
				}, nil
			},
		},
	}

	req := withSSHKeyAuth(httptest.NewRequest(http.MethodPost, "/api/user/keys", strings.NewReader(`{"title":"work-laptop","key":"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP8example"}`)), 3)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.CreateSSHKey(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	var payload services.SSHKeyResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, int64(99), payload.ID)
}

func TestSSHKeyHandler_DeleteSSHKey_InvalidID(t *testing.T) {
	t.Parallel()

	handler := SSHKeyHandler{Service: mockSSHKeyRouteService{}}
	for _, rawID := range []string{"abc", "0", "-1"} {
		t.Run(rawID, func(t *testing.T) {
			req := withSSHKeyAuth(withSSHKeyRouteParam(httptest.NewRequest(http.MethodDelete, "/api/user/keys/"+rawID, nil), rawID), 1)
			rec := httptest.NewRecorder()
			handler.DeleteSSHKey(rec, req)
			require.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}
}

func TestSSHKeyHandler_DeleteSSHKey_Unauthorized(t *testing.T) {
	t.Parallel()

	handler := SSHKeyHandler{Service: mockSSHKeyRouteService{}}
	req := withSSHKeyRouteParam(httptest.NewRequest(http.MethodDelete, "/api/user/keys/9", nil), "9")
	rec := httptest.NewRecorder()

	handler.DeleteSSHKey(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestSSHKeyHandler_DeleteSSHKey_Success204(t *testing.T) {
	t.Parallel()

	handler := SSHKeyHandler{
		Service: mockSSHKeyRouteService{
			deleteKeyFn: func(ctx context.Context, userID, keyID int64) error {
				assert.Equal(t, int64(20), userID)
				assert.Equal(t, int64(5), keyID)
				return nil
			},
		},
	}

	req := withSSHKeyAuth(withSSHKeyRouteParam(httptest.NewRequest(http.MethodDelete, "/api/user/keys/5", nil), "5"), 20)
	rec := httptest.NewRecorder()

	handler.DeleteSSHKey(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestSSHKeyHandler_PropagatesServiceAPIErrors(t *testing.T) {
	t.Parallel()

	handler := SSHKeyHandler{
		Service: mockSSHKeyRouteService{
			listKeysFn: func(ctx context.Context, userID int64) ([]services.SSHKeyResponse, error) {
				return nil, errors.Forbidden("insufficient token scope")
			},
		},
	}

	req := withSSHKeyAuth(httptest.NewRequest(http.MethodGet, "/api/user/keys", nil), 1)
	rec := httptest.NewRecorder()

	handler.ListSSHKeys(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
}

func withSSHKeyAuth(req *http.Request, userID int64) *http.Request {
	return req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: userID, Username: "tester", LowerUsername: "tester"},
	}))
}

func withSSHKeyRouteParam(req *http.Request, id string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}
