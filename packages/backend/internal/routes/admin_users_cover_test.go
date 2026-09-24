package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestAdminUsers_Cov_PatchUserAdminSuccessAndValidation(t *testing.T) {
	t.Parallel()

	t.Run("sets admin flag", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{
			setUserAdminFn: func(_ context.Context, username string, isAdmin bool) (services.UserProfile, error) {
				assert.Equal(t, "alice", username)
				assert.True(t, isAdmin)
				return services.UserProfile{Username: username, IsAdmin: true}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPatch, "/api/admin/users/alice/admin", bytes.NewBufferString(`{"is_admin":true}`))
		req = withURLParamAdminUser(req, "alice")
		rec := httptest.NewRecorder()

		h.PatchUserAdmin(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var profile services.UserProfile
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &profile))
		assert.True(t, profile.IsAdmin)
		assert.Equal(t, "alice", profile.Username)
	})

	t.Run("rejects missing username before body decode", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{
			setUserAdminFn: func(context.Context, string, bool) (services.UserProfile, error) {
				t.Fatal("service should not be called for missing username")
				return services.UserProfile{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPatch, "/api/admin/users/%20/admin", bytes.NewBufferString(`{"is_admin":true}`))
		req = withURLParamAdminUser(req, " ")
		rec := httptest.NewRecorder()

		h.PatchUserAdmin(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "username is required")
	})
}

func TestAdminUsers_Cov_PostUserTokenBranches(t *testing.T) {
	t.Parallel()

	t.Run("creates token", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{
			createTokenForUserFn: func(_ context.Context, username string, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
				assert.Equal(t, "bob", username)
				assert.Equal(t, "deploy", req.Name)
				assert.Equal(t, []string{"repo:read", "repo:write"}, req.Scopes)
				return services.CreateTokenResult{Token: "smithers-token"}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/admin/users/bob/tokens", bytes.NewBufferString(`{"name":"deploy","scopes":["repo:read","repo:write"]}`))
		req = withURLParamAdminUser(req, "bob")
		rec := httptest.NewRecorder()

		h.PostUserToken(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
		var result services.CreateTokenResult
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
		assert.Equal(t, "smithers-token", result.Token)
	})

	t.Run("propagates service validation", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{
			createTokenForUserFn: func(context.Context, string, services.CreateTokenRequest) (services.CreateTokenResult, error) {
				return services.CreateTokenResult{}, pkgerrors.BadRequest("token name is required")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/admin/users/bob/tokens", bytes.NewBufferString(`{"name":""}`))
		req = withURLParamAdminUser(req, "bob")
		rec := httptest.NewRecorder()

		h.PostUserToken(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "token name is required")
	})
}

func TestAdminUsers_Cov_PatchAndDeleteRejectMissingUsername(t *testing.T) {
	t.Parallel()

	t.Run("patch user", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/admin/users/%20", bytes.NewBufferString(`{"suspended":true}`))
		req = withURLParamAdminUser(req, " ")
		rec := httptest.NewRecorder()

		h.PatchUser(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete token", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/admin/users/%20/tokens/7", nil)
		req = withURLParamAdminToken(req, " ", "7")
		rec := httptest.NewRecorder()

		h.DeleteUserToken(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete user", func(t *testing.T) {
		t.Parallel()

		h := &AdminUserHandler{Service: &mockAdminUserService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/admin/users/%20", nil)
		req = withURLParamAdminUser(req, " ")
		rec := httptest.NewRecorder()

		h.DeleteUser(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
