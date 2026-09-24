package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// The real auth loader and repo lookup must not let an owner-issued run token
// execute the real administrative mutation. Ordinary owner PATs still can.
func TestRepositoryBoundTokenCannotArchiveOwnedRepository(t *testing.T) {
	pool := newGrantSecurityPool(t)
	ctx := context.Background()
	q := db.New(pool)
	owner := grantSecurityCreateUser(t, pool, "owner")
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "private", LowerName: "private", DefaultBookmark: "main"})
	require.NoError(t, err)
	env := &patGrantEnv{q: q}
	bound, _ := env.mintPAT(t, owner.ID, "write:repository,"+middleware.RepositoryRestrictionScope(repo.ID), time.Hour, true)
	unbound, _ := env.mintPAT(t, owner.ID, "write:repository", time.Hour, false)
	h := &RepoHandler{Service: services.NewProductRepoServiceWithPool(q, nil, pool)}
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(q, config.AuthConfig{}))
	router.Route("/api/repos/{owner}/{repo}", func(r chi.Router) {
		r.Use(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository), middleware.LoadRepoContext(q))
		r.With(middleware.RequireRepoPermission(middleware.PermissionAdmin)).Post("/archive", h.ArchiveRepo)
		r.With(middleware.RequireRepoPermission(middleware.PermissionWrite)).Post("/write-check", func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, middleware.PermissionWrite, middleware.RepoPermissionFromContext(r.Context()))
			w.WriteHeader(http.StatusNoContent)
		})
	})
	request := func(path, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/repos/owner/private/"+path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	rec := request("archive", bound)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	stored, err := q.GetRepoByID(ctx, repo.ID)
	require.NoError(t, err)
	require.False(t, stored.IsArchived)
	rec = request("write-check", bound)
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())
	rec = request("archive", unbound)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	stored, err = q.GetRepoByID(ctx, repo.ID)
	require.NoError(t, err)
	require.True(t, stored.IsArchived)
}
