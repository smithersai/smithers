package routes

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestAdminUsers_H_PatchAdminAndTokenBranches(t *testing.T) {
	t.Run("patch admin invalid json", func(t *testing.T) {
		h := &AdminUserHandler{Service: &mockAdminUserService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/admin/users/alice/admin", bytes.NewBufferString(`{`))
		req = withURLParamAdminUser(req, "alice")
		rec := httptest.NewRecorder()

		h.PatchUserAdmin(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("patch admin service error", func(t *testing.T) {
		h := &AdminUserHandler{Service: &mockAdminUserService{
			setUserAdminFn: func(context.Context, string, bool) (services.UserProfile, error) {
				return services.UserProfile{}, pkgerrors.Forbidden("admin permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodPatch, "/api/admin/users/alice/admin", bytes.NewBufferString(`{"is_admin":true}`))
		req = withURLParamAdminUser(req, "alice")
		rec := httptest.NewRecorder()

		h.PatchUserAdmin(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("post token missing username", func(t *testing.T) {
		h := &AdminUserHandler{Service: &mockAdminUserService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/admin/users/%20/tokens", bytes.NewBufferString(`{"name":"deploy"}`))
		req = withURLParamAdminUser(req, " ")
		rec := httptest.NewRecorder()

		h.PostUserToken(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("post token invalid json", func(t *testing.T) {
		h := &AdminUserHandler{Service: &mockAdminUserService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/admin/users/alice/tokens", bytes.NewBufferString(`{`))
		req = withURLParamAdminUser(req, "alice")
		rec := httptest.NewRecorder()

		h.PostUserToken(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
