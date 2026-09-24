package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestRepoHandler_NotesRoundTrip(t *testing.T) {
	sha := strings.Repeat("a", 40)
	for _, tc := range []struct {
		name           string
		absent, denied bool
	}{
		{name: "note"}, {name: "no notes", absent: true}, {name: "private non reader", denied: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			viewer := &db.User{ID: 9}
			svc := repoMissingEndpointMockService{
				listGitRefsFn: func(_ context.Context, user *db.User, owner, repo string) ([]services.GitRef, error) {
					require.Equal(t, viewer, user)
					if tc.denied {
						return nil, errors.Forbidden("permission denied")
					}
					if tc.absent {
						return []services.GitRef{}, nil
					}
					return []services.GitRef{{Ref: "refs/notes/mythical", Object: services.GitRefObject{SHA: sha, Type: "commit"}}}, nil
				},
				getRepoContentsFn: func(_ context.Context, user *db.User, owner, repo, ref, path string) (services.RepoContent, error) {
					require.Equal(t, viewer, user)
					if tc.denied {
						return services.RepoContent{}, errors.Forbidden("permission denied")
					}
					require.Equal(t, sha, ref)
					require.Equal(t, "ab/cd", path)
					return services.RepoContent{Name: "cd", Path: path, Type: "file", Encoding: "utf-8", Content: "story", Size: 5}, nil
				},
			}
			handler := RepoHandler{Service: svc}
			router := chi.NewRouter()
			router.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), middleware.UserContextKey, viewer)))
				})
			})
			router.Get("/api/repos/{owner}/{repo}/git/refs", handler.ListGitRefs)
			router.Get("/api/repos/{owner}/{repo}/contents/*", handler.GetRepoContents)
			refs := httptest.NewRecorder()
			router.ServeHTTP(refs, httptest.NewRequest("GET", "/api/repos/alice/demo/git/refs", nil))
			if tc.denied {
				require.Equal(t, 403, refs.Code)
			} else {
				require.Equal(t, 200, refs.Code)
				if tc.absent {
					require.JSONEq(t, "[]", refs.Body.String())
					return
				}
				var result []services.GitRef
				require.NoError(t, json.Unmarshal(refs.Body.Bytes(), &result))
				sha = result[0].Object.SHA
			}
			content := httptest.NewRecorder()
			router.ServeHTTP(content, httptest.NewRequest("GET", "/api/repos/alice/demo/contents/ab/cd?ref="+sha, nil))
			if tc.denied {
				require.Equal(t, 403, content.Code)
				require.JSONEq(t, refs.Body.String(), content.Body.String())
				return
			}
			require.Equal(t, 200, content.Code)
			require.JSONEq(t, `{"name":"cd","path":"ab/cd","sha":"","type":"file","encoding":"utf-8","content":"story","size":5}`, content.Body.String())
		})
	}
}

func TestRepoHandler_NoteReadDoesNotListTree(t *testing.T) {
	handler := RepoHandler{Service: mockRepoRouteService{
		getContentsFn: func(context.Context, *db.User, string, string, string, string) (services.RepoContent, error) {
			return services.RepoContent{Type: "file", Content: "story"}, nil
		},
		listContentsFn: func(context.Context, *db.User, string, string, string, string) ([]services.RepoContent, error) {
			t.Fatal("file read enumerated tree")
			return nil, nil
		},
	}}
	req := withRouteParams(httptest.NewRequest("GET", "/contents/ab/cd?ref="+strings.Repeat("a", 40), nil), map[string]string{"owner": "alice", "repo": "demo", "*": "ab/cd"})
	rec := httptest.NewRecorder()
	handler.GetRepoContents(rec, req)
	require.Equal(t, 200, rec.Code)
}
