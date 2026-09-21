package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestRequireAdmin(t *testing.T) {
	t.Parallel()

	t.Run("unauthenticated request returns 401", func(t *testing.T) {
		t.Parallel()

		nextCalled := false
		handler := RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))

		req := httptest.NewRequest(http.MethodGet, "/api/admin/runners", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusUnauthorized, rec.Code)
		assert.False(t, nextCalled)
	})

	t.Run("authenticated non-admin returns 403", func(t *testing.T) {
		t.Parallel()

		nextCalled := false
		handler := RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))

		req := httptest.NewRequest(http.MethodGet, "/api/admin/runners", nil)
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
			User:        &db.User{ID: 1, Username: "alice", IsAdmin: false},
			IsTokenAuth: true,
			Scopes:      ParseTokenScopes("read:repository"),
		}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
		assert.False(t, nextCalled)
	})

	t.Run("authenticated admin user proceeds", func(t *testing.T) {
		t.Parallel()

		nextCalled := false
		handler := RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))

		req := httptest.NewRequest(http.MethodGet, "/api/admin/runners", nil)
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
			User:        &db.User{ID: 2, Username: "boss", IsAdmin: true},
			IsTokenAuth: true,
			Scopes:      ParseTokenScopes("admin"),
		}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
		assert.True(t, nextCalled)
	})

	t.Run("token-authenticated admin user without admin scope returns 403", func(t *testing.T) {
		t.Parallel()

		nextCalled := false
		handler := RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))

		req := httptest.NewRequest(http.MethodGet, "/api/admin/runners", nil)
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
			User:        &db.User{ID: 20, Username: "boss-no-admin-scope", IsAdmin: true},
			IsTokenAuth: true,
			TokenSource: TokenSourcePersonalAccessToken,
			Scopes:      ParseTokenScopes("read:repository"),
		}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
		assert.Equal(t, "insufficient token scope", apiErrorMessage(t, rec))
		assert.False(t, nextCalled)
	})

	t.Run("oauth2 admin token is rejected", func(t *testing.T) {
		t.Parallel()

		nextCalled := false
		handler := RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))

		req := httptest.NewRequest(http.MethodGet, "/api/admin/runners", nil)
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
			User:        &db.User{ID: 21, Username: "oauth-admin", IsAdmin: true},
			IsTokenAuth: true,
			TokenSource: TokenSourceOAuth2AccessToken,
			Scopes:      ParseTokenScopes("read:admin"),
		}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
		assert.Equal(t, "oauth2 access tokens cannot access admin endpoints", apiErrorMessage(t, rec))
		assert.False(t, nextCalled)
	})

	t.Run("session-authenticated admin user proceeds", func(t *testing.T) {
		t.Parallel()

		nextCalled := false
		handler := RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))

		req := httptest.NewRequest(http.MethodGet, "/api/admin/runners", nil)
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
			User:        &db.User{ID: 3, Username: "sadmin", IsAdmin: true},
			IsTokenAuth: false,
		}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
		assert.True(t, nextCalled)
	})

	t.Run("error response uses APIError format", func(t *testing.T) {
		t.Parallel()

		handler := RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))

		req := httptest.NewRequest(http.MethodGet, "/api/admin/runners", nil)
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
			User:        &db.User{ID: 4, Username: "pleb", IsAdmin: false},
			IsTokenAuth: true,
			Scopes:      ParseTokenScopes("admin"),
		}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
		assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	})
}

func TestAdmin_RequiresAdminScope(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/admin/runners", nil)
	req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
		User:        &db.User{ID: 30, Username: "admin-no-scope", IsAdmin: true},
		IsTokenAuth: true,
		TokenSource: TokenSourcePersonalAccessToken,
		Scopes:      ParseTokenScopes("read:repository"),
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, "insufficient token scope", apiErrorMessage(t, rec))
	assert.False(t, nextCalled)
}

func TestAdmin_ReadOnlyTokenCantMutate(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := RequireAdmin(RequireScope(ScopeWriteAdmin)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	})))

	req := httptest.NewRequest(http.MethodPost, "/api/admin/users", nil)
	req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
		User:        &db.User{ID: 31, Username: "readonly-admin", IsAdmin: true},
		IsTokenAuth: true,
		TokenSource: TokenSourcePersonalAccessToken,
		Scopes:      ParseTokenScopes("read:admin"),
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, "insufficient token scope", apiErrorMessage(t, rec))
	assert.False(t, nextCalled)
}

func TestAdmin_NonAdminUser403(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/admin/users", nil)
	req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
		User:        &db.User{ID: 32, Username: "not-admin", IsAdmin: false},
		IsTokenAuth: true,
		TokenSource: TokenSourcePersonalAccessToken,
		Scopes:      ParseTokenScopes("write:admin"),
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, "admin access required", apiErrorMessage(t, rec))
	assert.False(t, nextCalled)
}
