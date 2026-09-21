package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Repro apps/ui/canary-repros/github/13.7: `/issues.create … octocat/Hello-World`
// answered 200 with an issue that exists nowhere on github.com, because the
// GitHub source coordinates resolved through import provenance into the
// requester's own private mirror. A read may follow that alias silently; a
// write may not, so the context has to carry the fact that it happened.
func TestLoadRepoContext_RecordsGitHubSourceAlias(t *testing.T) {
	t.Parallel()

	mirror := db.Repository{ID: 48, Name: "hello-world", LowerName: "hello-world", UserID: pgtype.Int8{Int64: 9, Valid: true}}

	t.Run("a provenance resolve records both halves of the alias", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoContextQuerier{
			getReadyImportedRepoForUserBySourceFn: func(_ context.Context, _ db.GetReadyImportedRepoForUserBySourceParams) (db.GetReadyImportedRepoForUserBySourceRow, error) {
				return db.GetReadyImportedRepoForUserBySourceRow{Repository: mirror, LocalOwner: "codeplanesmithers"}, nil
			},
		}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sourceOwner, sourceRepo, aliased := GitHubSourceAliasFromContext(r.Context())
			require.True(t, aliased)
			// The URL's coordinates, not the mirror's — a refusal has to be able
			// to name the repository the user actually asked for.
			assert.Equal(t, "octocat", sourceOwner)
			assert.Equal(t, "Hello-World", sourceRepo)
			rc := RepoContextFromContext(r.Context())
			require.NotNil(t, rc)
			assert.Equal(t, "codeplanesmithers", rc.Owner)
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodPost, "/api/repos/octocat/Hello-World/issues", nil), "octocat", "Hello-World")
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{User: &db.User{ID: 9, Username: "codeplanesmithers"}}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("a direct resolve records no alias", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoContextQuerier{
			getRepoByOwnerAndLowerNameFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return mirror, nil
			},
			getReadyImportedRepoForUserBySourceFn: func(_ context.Context, _ db.GetReadyImportedRepoForUserBySourceParams) (db.GetReadyImportedRepoForUserBySourceRow, error) {
				t.Fatal("provenance must not be consulted when the repository resolves directly")
				return db.GetReadyImportedRepoForUserBySourceRow{}, pgx.ErrNoRows
			},
		}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _, aliased := GitHubSourceAliasFromContext(r.Context())
			assert.False(t, aliased)
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodPost, "/api/repos/codeplanesmithers/hello-world/issues", nil), "codeplanesmithers", "hello-world")
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{User: &db.User{ID: 9, Username: "codeplanesmithers"}}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})
}
