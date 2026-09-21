package middleware

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockRepoContextQuerier struct {
	getRepoByOwnerAndLowerNameFn           func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	getReadyImportedRepoForUserBySourceFn  func(ctx context.Context, arg db.GetReadyImportedRepoForUserBySourceParams) (db.GetReadyImportedRepoForUserBySourceRow, error)
	isOrgOwnerForRepoUserFn                func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	getHighestTeamPermissionForRepoUserFn  func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	getCollaboratorPermissionForRepoUserFn func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
}

func (m *mockRepoContextQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if m.getRepoByOwnerAndLowerNameFn != nil {
		return m.getRepoByOwnerAndLowerNameFn(ctx, arg)
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (m *mockRepoContextQuerier) GetReadyImportedRepoForUserBySource(ctx context.Context, arg db.GetReadyImportedRepoForUserBySourceParams) (db.GetReadyImportedRepoForUserBySourceRow, error) {
	if m.getReadyImportedRepoForUserBySourceFn != nil {
		return m.getReadyImportedRepoForUserBySourceFn(ctx, arg)
	}
	return db.GetReadyImportedRepoForUserBySourceRow{}, pgx.ErrNoRows
}

func (m *mockRepoContextQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerForRepoUserFn != nil {
		return m.isOrgOwnerForRepoUserFn(ctx, arg)
	}
	return false, nil
}

func (m *mockRepoContextQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.getHighestTeamPermissionForRepoUserFn != nil {
		return m.getHighestTeamPermissionForRepoUserFn(ctx, arg)
	}
	return "", nil
}

func (m *mockRepoContextQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.getCollaboratorPermissionForRepoUserFn != nil {
		return m.getCollaboratorPermissionForRepoUserFn(ctx, arg)
	}
	return "", nil
}

func TestPermissionLevel_ParseAndSatisfies(t *testing.T) {
	t.Parallel()

	t.Run("parse known levels", func(t *testing.T) {
		t.Parallel()
		cases := []struct {
			raw  string
			want PermissionLevel
		}{
			{raw: "read", want: PermissionRead},
			{raw: "WRITE", want: PermissionWrite},
			{raw: " Admin ", want: PermissionAdmin},
			{raw: "owner", want: PermissionOwner},
		}
		for _, tc := range cases {
			got, err := ParsePermissionLevel(tc.raw)
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		}
	})

	t.Run("parse invalid level returns error", func(t *testing.T) {
		t.Parallel()
		_, err := ParsePermissionLevel("maintain")
		require.Error(t, err)
	})

	t.Run("rank satisfies", func(t *testing.T) {
		t.Parallel()
		assert.True(t, PermissionOwner.Satisfies(PermissionAdmin))
		assert.True(t, PermissionAdmin.Satisfies(PermissionWrite))
		assert.True(t, PermissionWrite.Satisfies(PermissionRead))
		assert.True(t, PermissionWrite.Satisfies(PermissionWrite))
		assert.False(t, PermissionRead.Satisfies(PermissionWrite))
		assert.False(t, PermissionNone.Satisfies(PermissionRead))
	})
}

func TestRepoContextHelpers(t *testing.T) {
	t.Parallel()

	repo := &db.Repository{ID: 42, Name: "demo", LowerName: "demo"}
	ctx := context.Background()
	ctx = context.WithValue(ctx, repoContextKey, &RepoContext{Owner: "alice", Repository: repo})
	ctx = context.WithValue(ctx, repoPermissionContextKey, PermissionWrite)

	gotRepo := RepoFromContext(ctx)
	require.NotNil(t, gotRepo)
	assert.Equal(t, int64(42), gotRepo.ID)
	assert.Equal(t, "demo", gotRepo.Name)
	assert.Equal(t, PermissionWrite, RepoPermissionFromContext(ctx))
}

func TestLoadRepoContext(t *testing.T) {
	t.Parallel()

	publicRepo := db.Repository{ID: 10, Name: "demo", LowerName: "demo", IsPublic: true, UserID: pgtype.Int8{Int64: 99, Valid: true}}
	privateRepo := db.Repository{ID: 11, Name: "secret", LowerName: "secret", IsPublic: false, UserID: pgtype.Int8{Int64: 99, Valid: true}}
	orgRepo := db.Repository{ID: 12, Name: "org-repo", LowerName: "org-repo", IsPublic: false, OrgID: pgtype.Int8{Int64: 55, Valid: true}}

	t.Run("loads public repo for anonymous user and assigns read", func(t *testing.T) {
		t.Parallel()
		hitNext := false
		q := &mockRepoContextQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				assert.Equal(t, "alice", arg.Owner)
				assert.Equal(t, "demo", arg.LowerName)
				return publicRepo, nil
			},
		}

		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hitNext = true
			gotRepo := RepoFromContext(r.Context())
			require.NotNil(t, gotRepo)
			assert.Equal(t, int64(10), gotRepo.ID)
			assert.Equal(t, PermissionRead, RepoPermissionFromContext(r.Context()))
			w.WriteHeader(http.StatusNoContent)
		}))

		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil), "alice", "demo")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		assert.True(t, hitNext)
	})

	t.Run("private repo anonymous is masked as missing", func(t *testing.T) {
		t.Parallel()
		hitNext := false
		q := &mockRepoContextQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		}}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hitNext = true
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/secret", nil), "alice", "secret")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.False(t, hitNext)
		assert.Equal(t, "repository not found", repoCtxAPIErrorMessage(t, rec))
	})

	t.Run("private repo without read permission is masked as missing", func(t *testing.T) {
		t.Parallel()
		hitNext := false
		q := &mockRepoContextQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		}}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hitNext = true
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/secret", nil), "alice", "secret")
		req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &db.User{ID: 10, Username: "carol"}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.False(t, hitNext)
		assert.Equal(t, "repository not found", repoCtxAPIErrorMessage(t, rec))
	})

	t.Run("private repo is masked when token lacks repository read scope", func(t *testing.T) {
		t.Parallel()
		hitNext := false
		q := &mockRepoContextQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		}}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hitNext = true
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/secret", nil), "alice", "secret")
		ctx := ContextWithAuthInfo(req.Context(), &AuthInfo{
			User:        &db.User{ID: 99, Username: "alice"},
			IsTokenAuth: true,
			Scopes:      ParseTokenScopes(string(ScopeReadUser)),
		})
		req = req.WithContext(ctx)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.False(t, hitNext)
		assert.Equal(t, "repository not found", repoCtxAPIErrorMessage(t, rec))
	})

	t.Run("private repo owner with repository token scope resolves", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoContextQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		}}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, PermissionOwner, RepoPermissionFromContext(r.Context()))
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/secret", nil), "alice", "secret")
		ctx := ContextWithAuthInfo(req.Context(), &AuthInfo{
			User:        &db.User{ID: 99, Username: "alice"},
			IsTokenAuth: true,
			Scopes:      ParseTokenScopes(string(ScopeReadRepository)),
		})
		req = req.WithContext(ctx)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("repo-bound token resolves owner on its bound repository", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoContextQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		}}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, PermissionOwner, RepoPermissionFromContext(r.Context()))
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/secret", nil), "alice", "secret")
		rawScopes := string(ScopeWriteRepository) + "," + RepositoryRestrictionScope(privateRepo.ID)
		ctx := ContextWithAuthInfo(req.Context(), &AuthInfo{
			User:        &db.User{ID: 99, Username: "alice"},
			IsTokenAuth: true,
			RawScopes:   rawScopes,
			Scopes:      ParseTokenScopes(rawScopes),
		})
		req = req.WithContext(ctx)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("repo-bound token is anonymous on the owner's OTHER private repo", func(t *testing.T) {
		t.Parallel()
		hitNext := false
		q := &mockRepoContextQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		}}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hitNext = true
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/secret", nil), "alice", "secret")
		// Bound to repo 10, requesting repo 11 — even as the repo OWNER the
		// token must not authorize access.
		rawScopes := string(ScopeWriteRepository) + "," + RepositoryRestrictionScope(publicRepo.ID)
		ctx := ContextWithAuthInfo(req.Context(), &AuthInfo{
			User:        &db.User{ID: 99, Username: "alice"},
			IsTokenAuth: true,
			RawScopes:   rawScopes,
			Scopes:      ParseTokenScopes(rawScopes),
		})
		req = req.WithContext(ctx)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.False(t, hitNext)
		assert.Equal(t, "repository not found", repoCtxAPIErrorMessage(t, rec))
	})

	t.Run("repo-bound token gets only anonymous read on the owner's OTHER public repo", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoContextQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return publicRepo, nil
		}}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, PermissionRead, RepoPermissionFromContext(r.Context()))
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil), "alice", "demo")
		rawScopes := string(ScopeWriteRepository) + "," + RepositoryRestrictionScope(privateRepo.ID)
		ctx := ContextWithAuthInfo(req.Context(), &AuthInfo{
			User:        &db.User{ID: 99, Username: "alice"},
			IsTokenAuth: true,
			RawScopes:   rawScopes,
			Scopes:      ParseTokenScopes(rawScopes),
		})
		req = req.WithContext(ctx)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("read permission middleware cannot distinguish private repo from missing repo", func(t *testing.T) {
		t.Parallel()

		handlerForRepo := func(repo db.Repository, err error) http.Handler {
			return LoadRepoContext(&mockRepoContextQuerier{
				getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return repo, err
				},
			})(RequireRepoPermission(PermissionRead)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Fatal("handler should not be called")
			})))
		}

		cases := []struct {
			name    string
			handler http.Handler
		}{
			{
				name:    "missing repo",
				handler: handlerForRepo(db.Repository{}, pgx.ErrNoRows),
			},
			{
				name:    "unreadable private repo",
				handler: handlerForRepo(privateRepo, nil),
			},
		}

		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				t.Parallel()
				req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/secret", nil), "alice", "secret")
				rec := httptest.NewRecorder()
				tc.handler.ServeHTTP(rec, req)

				require.Equal(t, http.StatusNotFound, rec.Code)
				assert.Equal(t, "repository not found", repoCtxAPIErrorMessage(t, rec))
			})
		}
	})

	t.Run("auth-required routes cannot distinguish private repo from missing repo", func(t *testing.T) {
		t.Parallel()

		handlerForRepo := func(repo db.Repository, err error) http.Handler {
			return LoadRepoContext(&mockRepoContextQuerier{
				getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return repo, err
				},
			})(RequireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Fatal("handler should not be called")
			})))
		}

		cases := []struct {
			name    string
			handler http.Handler
		}{
			{
				name:    "missing repo",
				handler: handlerForRepo(db.Repository{}, pgx.ErrNoRows),
			},
			{
				name:    "unreadable private repo",
				handler: handlerForRepo(privateRepo, nil),
			},
		}

		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				t.Parallel()
				req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/secret/stream", nil), "alice", "secret")
				rec := httptest.NewRecorder()
				tc.handler.ServeHTTP(rec, req)

				require.Equal(t, http.StatusNotFound, rec.Code)
				assert.Equal(t, "repository not found", repoCtxAPIErrorMessage(t, rec))
			})
		}
	})

	t.Run("org owner resolves to owner", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoContextQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return orgRepo, nil
			},
			isOrgOwnerForRepoUserFn: func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
				assert.Equal(t, orgRepo.ID, arg.RepositoryID)
				assert.Equal(t, int64(7), arg.UserID)
				return true, nil
			},
		}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, PermissionOwner, RepoPermissionFromContext(r.Context()))
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/acme/org-repo", nil), "acme", "org-repo")
		req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &db.User{ID: 7, Username: "alice"}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("team write resolves to write", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoContextQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return orgRepo, nil
			},
			isOrgOwnerForRepoUserFn: func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
				return false, nil
			},
			getHighestTeamPermissionForRepoUserFn: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
				return "write", nil
			},
		}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, PermissionWrite, RepoPermissionFromContext(r.Context()))
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/acme/org-repo", nil), "acme", "org-repo")
		req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &db.User{ID: 9, Username: "bob"}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("collaborator read resolves to read", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoContextQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return privateRepo, nil
			},
			getCollaboratorPermissionForRepoUserFn: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
				return "read", nil
			},
		}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, PermissionRead, RepoPermissionFromContext(r.Context()))
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/secret", nil), "alice", "secret")
		req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &db.User{ID: 10, Username: "carol"}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("missing owner returns bad request", func(t *testing.T) {
		t.Parallel()
		h := LoadRepoContext(&mockRepoContextQuerier{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos//demo", nil), "", "demo")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Equal(t, "owner is required", repoCtxAPIErrorMessage(t, rec))
	})

	t.Run("repo not found returns not found", func(t *testing.T) {
		t.Parallel()
		h := LoadRepoContext(&mockRepoContextQuerier{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/missing", nil), "alice", "missing")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.Equal(t, "repository not found", repoCtxAPIErrorMessage(t, rec))
	})

	t.Run("repo lookup failure returns internal", func(t *testing.T) {
		t.Parallel()
		h := LoadRepoContext(&mockRepoContextQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, assert.AnError
		}})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil), "alice", "demo")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("permission lookup failure returns internal", func(t *testing.T) {
		t.Parallel()
		h := LoadRepoContext(&mockRepoContextQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return orgRepo, nil
			},
			isOrgOwnerForRepoUserFn: func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
				return false, assert.AnError
			},
		})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/acme/org-repo", nil), "acme", "org-repo")
		req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &db.User{ID: 10, Username: "carol"}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("owner user resolves to owner permission", func(t *testing.T) {
		t.Parallel()
		h := LoadRepoContext(&mockRepoContextQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 14, Name: "demo", LowerName: "demo", IsPublic: false, UserID: pgtype.Int8{Int64: 42, Valid: true}}, nil
			},
		})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, PermissionOwner, RepoPermissionFromContext(r.Context()))
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil), "alice", "demo")
		req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &db.User{ID: 42, Username: "alice"}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("invalid permission value from db returns internal", func(t *testing.T) {
		t.Parallel()
		h := LoadRepoContext(&mockRepoContextQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return orgRepo, nil
			},
			getHighestTeamPermissionForRepoUserFn: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
				return "maintain", nil
			},
		})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/acme/org-repo", nil), "acme", "org-repo")
		req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &db.User{ID: 10, Username: "carol"}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

func TestRequireMatchingRepositoryRestriction(t *testing.T) {
	t.Parallel()

	repository := db.Repository{ID: 42, Name: "public", IsPublic: true}
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	handler := RequireMatchingRepositoryRestriction(next)

	tests := []struct {
		name       string
		rawScopes  string
		withRepo   bool
		wantStatus int
	}{
		{name: "unrestricted token", rawScopes: string(ScopeReadRepository), withRepo: true, wantStatus: http.StatusNoContent},
		{name: "matching repository", rawScopes: string(ScopeReadRepository) + "," + RepositoryRestrictionScope(42), withRepo: true, wantStatus: http.StatusNoContent},
		{name: "mismatched public repository", rawScopes: string(ScopeReadRepository) + "," + RepositoryRestrictionScope(7), withRepo: true, wantStatus: http.StatusForbidden},
		{name: "missing repository context fails closed", rawScopes: string(ScopeReadRepository) + "," + RepositoryRestrictionScope(42), wantStatus: http.StatusInternalServerError},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/public/memory/browse", nil)
			ctx := ContextWithAuthInfo(req.Context(), &AuthInfo{
				User:        &db.User{ID: 1, Username: "alice"},
				IsTokenAuth: true,
				RawScopes:   tt.rawScopes,
				Scopes:      ParseTokenScopes(tt.rawScopes),
			})
			if tt.withRepo {
				ctx = ContextWithRepoContext(ctx, &RepoContext{Owner: "alice", Repository: &repository}, PermissionRead)
			}
			req = req.WithContext(ctx)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, req)
			require.Equal(t, tt.wantStatus, recorder.Code)
		})
	}
}

func TestRequireRepoPermission(t *testing.T) {
	t.Parallel()

	t.Run("sufficient permission allows request", func(t *testing.T) {
		t.Parallel()
		nextCalled := false
		h := RequireRepoPermission(PermissionWrite)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))

		ctx := context.WithValue(context.Background(), repoPermissionContextKey, PermissionOwner)
		req := httptest.NewRequest(http.MethodPost, "/", nil).WithContext(ctx)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		assert.True(t, nextCalled)
	})

	t.Run("exact permission allows request", func(t *testing.T) {
		t.Parallel()
		nextCalled := false
		h := RequireRepoPermission(PermissionRead)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))
		ctx := context.WithValue(context.Background(), repoPermissionContextKey, PermissionRead)
		req := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(ctx)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
		assert.True(t, nextCalled)
	})

	t.Run("insufficient permission returns forbidden", func(t *testing.T) {
		t.Parallel()
		nextCalled := false
		h := RequireRepoPermission(PermissionWrite)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))
		ctx := context.WithValue(context.Background(), repoPermissionContextKey, PermissionRead)
		req := httptest.NewRequest(http.MethodPost, "/", nil).WithContext(ctx)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
		assert.False(t, nextCalled)
	})

	t.Run("admin does not satisfy owner-only route", func(t *testing.T) {
		t.Parallel()
		nextCalled := false
		h := RequireRepoPermission(PermissionOwner)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))
		ctx := context.WithValue(context.Background(), repoPermissionContextKey, PermissionAdmin)
		req := httptest.NewRequest(http.MethodPost, "/", nil).WithContext(ctx)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
		assert.False(t, nextCalled)
	})

	t.Run("missing repo context returns internal", func(t *testing.T) {
		t.Parallel()
		nextCalled := false
		h := RequireRepoPermission(PermissionRead)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.False(t, nextCalled)
		assert.Equal(t, "repository context not loaded", repoCtxAPIErrorMessage(t, rec))
	})
}

func withRepoRouteParams(req *http.Request, owner, repo string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("owner", owner)
	rctx.URLParams.Add("repo", repo)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func repoCtxAPIErrorMessage(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var payload struct {
		Message string `json:"message"`
	}
	err := json.Unmarshal(rec.Body.Bytes(), &payload)
	require.NoError(t, err)
	return payload.Message
}

func TestRepoPermissionFromContext_DefaultNone(t *testing.T) {
	t.Parallel()
	assert.Equal(t, PermissionNone, RepoPermissionFromContext(context.Background()))
}

func TestParsePermissionLevel_ErrorWrapsInvalidValue(t *testing.T) {
	t.Parallel()
	_, err := ParsePermissionLevel("invalid")
	require.Error(t, err)
	assert.True(t, stdErrors.Is(err, ErrInvalidPermissionLevel))
}

// Coverage gap fixes for Satisfies - nil/unknown permission paths
func TestPermissionLevel_Satisfies_EdgeCases(t *testing.T) {
	t.Parallel()

	t.Run("none satisfies none", func(t *testing.T) {
		t.Parallel()
		assert.True(t, PermissionNone.Satisfies(PermissionNone))
	})

	t.Run("any permission satisfies none", func(t *testing.T) {
		t.Parallel()
		assert.True(t, PermissionRead.Satisfies(PermissionNone))
		assert.True(t, PermissionWrite.Satisfies(PermissionNone))
		assert.True(t, PermissionAdmin.Satisfies(PermissionNone))
		assert.True(t, PermissionOwner.Satisfies(PermissionNone))
	})

	t.Run("empty permission level behaves as none", func(t *testing.T) {
		t.Parallel()
		empty := PermissionLevel("")
		assert.True(t, empty.Satisfies(PermissionNone))
		assert.False(t, empty.Satisfies(PermissionRead))
	})
}

// Coverage gap fix for RepoFromContext - nil context path
func TestRepoFromContext_NilRepoContext(t *testing.T) {
	t.Parallel()

	t.Run("returns nil when repo context is nil", func(t *testing.T) {
		t.Parallel()
		ctx := context.WithValue(context.Background(), repoContextKey, nil)
		got := RepoFromContext(ctx)
		assert.Nil(t, got)
	})

	t.Run("returns nil when repo context not present", func(t *testing.T) {
		t.Parallel()
		got := RepoFromContext(context.Background())
		assert.Nil(t, got)
	})
}

// Coverage gap fix for LoadRepoContext - missing repo name
func TestLoadRepoContext_MissingRepoName(t *testing.T) {
	t.Parallel()
	h := LoadRepoContext(&mockRepoContextQuerier{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/", nil), "alice", "")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Equal(t, "repository name is required", repoCtxAPIErrorMessage(t, rec))
}

// Coverage gap fix for LoadRepoContext - nil queries
func TestLoadRepoContext_NilQueries(t *testing.T) {
	t.Parallel()
	h := LoadRepoContext(nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil), "alice", "demo")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, "repository context queries are not configured", repoCtxAPIErrorMessage(t, rec))
}

// Coverage gap fix for resolveRepoPermission - collaborator lookup error
func TestLoadRepoContext_CollaboratorLookupError(t *testing.T) {
	t.Parallel()
	privateRepo := db.Repository{ID: 11, Name: "secret", LowerName: "secret", IsPublic: false, UserID: pgtype.Int8{Int64: 99, Valid: true}}

	h := LoadRepoContext(&mockRepoContextQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		},
		getCollaboratorPermissionForRepoUserFn: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "", assert.AnError
		},
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/secret", nil), "alice", "secret")
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &db.User{ID: 10, Username: "carol"}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

// Coverage gap fix for resolveRepoPermission - public repo with no explicit permission
func TestLoadRepoContext_PublicRepoNoExplicitPermission(t *testing.T) {
	t.Parallel()
	publicOrgRepo := db.Repository{
		ID:        15,
		Name:      "public-org-repo",
		LowerName: "public-org-repo",
		IsPublic:  true,
		OrgID:     pgtype.Int8{Int64: 55, Valid: true},
	}

	h := LoadRepoContext(&mockRepoContextQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return publicOrgRepo, nil
		},
		isOrgOwnerForRepoUserFn: func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
			return false, nil
		},
		getHighestTeamPermissionForRepoUserFn: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "", nil
		},
		getCollaboratorPermissionForRepoUserFn: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "", nil
		},
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// When user has no explicit permission but repo is public, should get read
		assert.Equal(t, PermissionRead, RepoPermissionFromContext(r.Context()))
		w.WriteHeader(http.StatusNoContent)
	}))
	req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/acme/public-org-repo", nil), "acme", "public-org-repo")
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &db.User{ID: 10, Username: "carol"}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusNoContent, rec.Code)
}

// Coverage gap fix for maxPermission - admin/owner path
func TestMaxPermission_AdminOwnerPath(t *testing.T) {
	t.Parallel()

	t.Run("owner beats admin", func(t *testing.T) {
		t.Parallel()
		result := maxPermission(PermissionAdmin, PermissionOwner)
		assert.Equal(t, PermissionOwner, result)
	})

	t.Run("admin beats write", func(t *testing.T) {
		t.Parallel()
		result := maxPermission(PermissionWrite, PermissionAdmin)
		assert.Equal(t, PermissionAdmin, result)
	})

	t.Run("admin beats read", func(t *testing.T) {
		t.Parallel()
		result := maxPermission(PermissionRead, PermissionAdmin)
		assert.Equal(t, PermissionAdmin, result)
	})

	t.Run("admin beats none", func(t *testing.T) {
		t.Parallel()
		result := maxPermission(PermissionNone, PermissionAdmin)
		assert.Equal(t, PermissionAdmin, result)
	})

	t.Run("same permission returns first", func(t *testing.T) {
		t.Parallel()
		result := maxPermission(PermissionAdmin, PermissionAdmin)
		assert.Equal(t, PermissionAdmin, result)
		result = maxPermission(PermissionOwner, PermissionOwner)
		assert.Equal(t, PermissionOwner, result)
	})
}

// Additional edge case: collaborator invalid permission parsing
func TestLoadRepoContext_CollaboratorInvalidPermission(t *testing.T) {
	t.Parallel()
	privateRepo := db.Repository{ID: 11, Name: "secret", LowerName: "secret", IsPublic: false, UserID: pgtype.Int8{Int64: 99, Valid: true}}

	h := LoadRepoContext(&mockRepoContextQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		},
		getCollaboratorPermissionForRepoUserFn: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "invalid_perm", nil
		},
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/secret", nil), "alice", "secret")
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &db.User{ID: 10, Username: "carol"}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, "failed to parse repository permission", repoCtxAPIErrorMessage(t, rec))
}

// Mirrors are namespaced under the IMPORTING user ("smithersai/smithers" →
// "alice/smithers"), but clients keep addressing them by GitHub source
// coordinates. LoadRepoContext must resolve those through the requester's own
// ready import provenance — and only theirs.
func TestLoadRepoContext_SourceProvenanceFallback(t *testing.T) {
	t.Parallel()

	mirrorRepo := db.Repository{ID: 77, Name: "smithers", LowerName: "smithers", IsPublic: false, UserID: pgtype.Int8{Int64: 99, Valid: true}}

	t.Run("github source coords resolve to the requester's imported mirror", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoContextQuerier{
			getReadyImportedRepoForUserBySourceFn: func(ctx context.Context, arg db.GetReadyImportedRepoForUserBySourceParams) (db.GetReadyImportedRepoForUserBySourceRow, error) {
				assert.Equal(t, int64(99), arg.UserID)
				assert.Equal(t, "smithersai", arg.GithubOwner)
				assert.Equal(t, "smithers", arg.GithubRepo)
				return db.GetReadyImportedRepoForUserBySourceRow{Repository: mirrorRepo, LocalOwner: "alice"}, nil
			},
		}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotRepo := RepoFromContext(r.Context())
			require.NotNil(t, gotRepo)
			assert.Equal(t, int64(77), gotRepo.ID)
			// Repo-host/workspace ops key storage paths on the context owner: it
			// must be the mirror's real namespace, never the URL's source owner.
			rc := RepoContextFromContext(r.Context())
			require.NotNil(t, rc)
			assert.Equal(t, "alice", rc.Owner)
			assert.Equal(t, PermissionOwner, RepoPermissionFromContext(r.Context()))
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/SmithersAI/Smithers", nil), "SmithersAI", "Smithers")
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{User: &db.User{ID: 99, Username: "alice"}}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("anonymous request never consults provenance", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoContextQuerier{
			getReadyImportedRepoForUserBySourceFn: func(ctx context.Context, arg db.GetReadyImportedRepoForUserBySourceParams) (db.GetReadyImportedRepoForUserBySourceRow, error) {
				t.Fatal("provenance lookup must not run for anonymous requests")
				return db.GetReadyImportedRepoForUserBySourceRow{}, pgx.ErrNoRows
			},
		}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/smithersai/smithers", nil), "smithersai", "smithers")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.Equal(t, "repository not found", repoCtxAPIErrorMessage(t, rec))
	})

	t.Run("user without a matching import still gets not found", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoContextQuerier{}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/smithersai/smithers", nil), "smithersai", "smithers")
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{User: &db.User{ID: 12, Username: "mallory"}}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.Equal(t, "repository not found", repoCtxAPIErrorMessage(t, rec))
	})

	t.Run("token auth without read-repository scope never consults provenance", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoContextQuerier{
			getReadyImportedRepoForUserBySourceFn: func(ctx context.Context, arg db.GetReadyImportedRepoForUserBySourceParams) (db.GetReadyImportedRepoForUserBySourceRow, error) {
				t.Fatal("provenance lookup must not run without read:repository")
				return db.GetReadyImportedRepoForUserBySourceRow{}, pgx.ErrNoRows
			},
		}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/smithersai/smithers", nil), "smithersai", "smithers")
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
			User:        &db.User{ID: 99, Username: "alice"},
			IsTokenAuth: true,
			Scopes:      ParseTokenScopes(string(ScopeReadUser)),
		}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("provenance lookup failure is a server error, not a masked 404", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoContextQuerier{
			getReadyImportedRepoForUserBySourceFn: func(ctx context.Context, arg db.GetReadyImportedRepoForUserBySourceParams) (db.GetReadyImportedRepoForUserBySourceRow, error) {
				return db.GetReadyImportedRepoForUserBySourceRow{}, stdErrors.New("connection reset")
			},
		}
		h := LoadRepoContext(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/smithersai/smithers", nil), "smithersai", "smithers")
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{User: &db.User{ID: 99, Username: "alice"}}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Equal(t, "failed to resolve repository", repoCtxAPIErrorMessage(t, rec))
	})
}
