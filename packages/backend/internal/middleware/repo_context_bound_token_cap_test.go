package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A repository-bound token (per-run sandbox/agent token carrying
// write:repository + repo:<id>) is issued for one run's writes. It must never
// resolve above PermissionWrite on the repository it names: a leaked token
// otherwise reaches DELETE /repos/{o}/{r}, POST /archive, PATCH /repos/{o}/{r}
// {"private":false}, hooks, deploy keys and secrets as the owner.
func TestLoadRepoContext_RepositoryBoundTokenCappedAtWrite(t *testing.T) {
	repo := db.Repository{ID: 101, Name: "demo", LowerName: "demo", IsPublic: false, UserID: pgtype.Int8{Int64: 1, Valid: true}}
	queries := &mockRepoContextQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
	}
	scopes := string(ScopeWriteRepository) + "," + RepositoryRestrictionScope(repo.ID)
	newRequest := func(bound bool) *http.Request {
		raw := string(ScopeWriteRepository)
		if bound {
			raw = scopes
		}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo", nil)
		req = withRepoRouteParams(req, "alice", "demo")
		return req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
			User:        &db.User{ID: 1, Username: "alice", LowerUsername: "alice"},
			RawScopes:   raw,
			Scopes:      ParseTokenScopes(raw),
			IsTokenAuth: true,
		}))
	}

	var seen PermissionLevel
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = RepoPermissionFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	})

	t.Run("bound token is refused by admin and owner stacks", func(t *testing.T) {
		for _, required := range []PermissionLevel{PermissionAdmin, PermissionOwner} {
			seen = PermissionNone
			chain := RequireAuth(RequireScope(ScopeWriteRepository)(LoadRepoContext(queries)(RequireRepoPermission(required)(handler))))
			rec := httptest.NewRecorder()
			chain.ServeHTTP(rec, newRequest(true))
			assert.Equal(t, http.StatusForbidden, rec.Code, "required=%s", required)
			assert.Equal(t, PermissionNone, seen, "handler must not run for required=%s", required)
		}
	})

	t.Run("bound token still satisfies the write stack on its own repository", func(t *testing.T) {
		chain := RequireAuth(RequireScope(ScopeWriteRepository)(LoadRepoContext(queries)(RequireRepoPermission(PermissionWrite)(handler))))
		rec := httptest.NewRecorder()
		chain.ServeHTTP(rec, newRequest(true))
		require.Equal(t, http.StatusNoContent, rec.Code)
		assert.Equal(t, PermissionWrite, seen)
	})

	t.Run("unbound owner token keeps owner permission", func(t *testing.T) {
		chain := RequireAuth(RequireScope(ScopeWriteRepository)(LoadRepoContext(queries)(RequireRepoPermission(PermissionOwner)(handler))))
		rec := httptest.NewRecorder()
		chain.ServeHTTP(rec, newRequest(false))
		require.Equal(t, http.StatusNoContent, rec.Code)
		assert.Equal(t, PermissionOwner, seen)
	})
}
