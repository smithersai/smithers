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

func TestSSHKeys_Cov_ServiceErrors(t *testing.T) {
	t.Parallel()

	t.Run("get propagates service api error", func(t *testing.T) {
		h := SSHKeyHandler{Service: mockSSHKeyRouteService{
			getKeyByIDFn: func(ctx context.Context, userID, keyID int64) (services.SSHKeyResponse, error) {
				assert.Equal(t, int64(7), userID)
				assert.Equal(t, int64(44), keyID)
				return services.SSHKeyResponse{}, pkgerrors.NotFound("ssh key not found")
			},
		}}
		req := withSSHKeyAuth(withSSHKeyRouteParam(httptest.NewRequest(http.MethodGet, "/api/user/keys/44", nil), "44"), 7)
		rec := httptest.NewRecorder()

		h.GetSSHKey(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.Contains(t, rec.Body.String(), "ssh key not found")
	})

	t.Run("create propagates validation error", func(t *testing.T) {
		h := SSHKeyHandler{Service: mockSSHKeyRouteService{
			createKeyFn: func(ctx context.Context, userID int64, req services.CreateSSHKeyRequest) (services.SSHKeyResponse, error) {
				assert.Equal(t, int64(8), userID)
				assert.Equal(t, "bad", req.Title)
				return services.SSHKeyResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{
					Resource: "SSHKey",
					Field:    "key",
					Code:     "invalid",
				})
			},
		}}
		req := withSSHKeyAuth(httptest.NewRequest(http.MethodPost, "/api/user/keys", strings.NewReader(`{"title":"bad","key":"not-a-key"}`)), 8)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		h.CreateSSHKey(rec, req)

		require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
		assert.Contains(t, rec.Body.String(), "invalid")
	})

	t.Run("delete propagates conflict", func(t *testing.T) {
		h := SSHKeyHandler{Service: mockSSHKeyRouteService{
			deleteKeyFn: func(ctx context.Context, userID, keyID int64) error {
				assert.Equal(t, int64(9), userID)
				assert.Equal(t, int64(12), keyID)
				return pkgerrors.Conflict("key is still in use")
			},
		}}
		req := withSSHKeyAuth(withSSHKeyRouteParam(httptest.NewRequest(http.MethodDelete, "/api/user/keys/12", nil), "12"), 9)
		rec := httptest.NewRecorder()

		h.DeleteSSHKey(rec, req)

		require.Equal(t, http.StatusConflict, rec.Code)
		assert.Contains(t, rec.Body.String(), "key is still in use")
	})
}
