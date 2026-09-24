package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestPublicReadAsAnonymousWithoutTokenScope(t *testing.T) {
	t.Parallel()

	var seen *db.User
	handler := PublicReadAsAnonymousWithoutTokenScope(ScopeReadOrganization)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = UserFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))
	alice := &db.User{ID: 1, Username: "alice"}
	serve := func(info *AuthInfo) int {
		seen = nil
		req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/repos", nil)
		if info != nil {
			req = req.WithContext(ContextWithAuthInfo(req.Context(), info))
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec.Code
	}

	require.Equal(t, http.StatusOK, serve(nil))
	require.Nil(t, seen)

	require.Equal(t, http.StatusOK, serve(&AuthInfo{User: alice, IsTokenAuth: false}))
	require.Same(t, alice, seen, "session callers keep their identity")

	require.Equal(t, http.StatusOK, serve(&AuthInfo{User: alice, IsTokenAuth: true, Scopes: ScopeSet{ScopeReadOrganization: {}}}))
	require.Same(t, alice, seen, "read:organization token keeps its identity")

	require.Equal(t, http.StatusOK, serve(&AuthInfo{User: alice, IsTokenAuth: true, Scopes: ScopeSet{ScopeReadUser: {}, ScopeReadRepository: {}, ScopeWriteRepository: {}}}))
	require.Nil(t, seen, "token without read:organization is served anonymously, never refused")

	require.Equal(t, http.StatusOK, serve(&AuthInfo{User: alice, IsTokenAuth: true, Scopes: ScopeSet{}}))
	require.Nil(t, seen, "scopeless token is served anonymously")

	require.Equal(t, http.StatusOK, serve(&AuthInfo{User: alice, IsTokenAuth: true, Scopes: ScopeSet{ScopeReadOrganization: {}}, RawScopes: "read:organization," + RepositoryRestrictionScope(42)}))
	require.Nil(t, seen, "repository-bound token is served anonymously")
}
