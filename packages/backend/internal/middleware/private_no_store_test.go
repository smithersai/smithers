package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestPrivateNoStoreAppliesToDownstreamErrors(t *testing.T) {
	t.Parallel()

	handler := PrivateNoStore(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "denied", http.StatusForbidden)
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/private", nil))

	require.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
}

func TestRejectRepositoryRestrictedTokenStopsBeforeHandler(t *testing.T) {
	t.Parallel()

	calls := 0
	handler := RejectRepositoryRestrictedToken(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/user-global", nil)
	req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
		User:        &db.User{ID: 7, Username: "octo"},
		RawScopes:   string(ScopeReadRepository) + "," + RepositoryRestrictionScope(99),
		Scopes:      ParseTokenScopes(string(ScopeReadRepository)),
		IsTokenAuth: true,
		TokenSource: TokenSourcePersonalAccessToken,
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, 0, calls)
}
