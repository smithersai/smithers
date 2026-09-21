package routes

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type jjVCSCovResolver struct {
	fn          func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error)
	protectedFn func(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error)
}

func (r jjVCSCovResolver) GetRepoByOwnerAndName(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
	return r.fn(ctx, arg)
}

func (r jjVCSCovResolver) ListAllProtectedBookmarksByRepo(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error) {
	if r.protectedFn != nil {
		return r.protectedFn(ctx, repositoryID)
	}
	return nil, nil
}

type jjVCSCovDispatcher struct {
	err error
}

func (d jjVCSCovDispatcher) DispatchEvent(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
	return d.err
}

func (d jjVCSCovDispatcher) DispatchOrgEvent(ctx context.Context, orgID int64, eventType webhooks.EventType, payload any) error {
	return d.err
}

func TestJJVCS_Cov_RepohostErrToAPIErrBranches(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantMsg    string
	}{
		{
			name:       "unauthorized status is sanitized",
			err:        &repohost.StatusError{StatusCode: http.StatusUnauthorized, Message: "token leaked detail"},
			wantStatus: http.StatusUnauthorized,
			wantMsg:    "repo-host authorization failed",
		},
		{
			name:       "forbidden status is sanitized",
			err:        &repohost.StatusError{StatusCode: http.StatusForbidden, Message: "private detail"},
			wantStatus: http.StatusForbidden,
			wantMsg:    "repo-host permission denied",
		},
		{
			name:       "unmapped status uses internal fallback",
			err:        &repohost.StatusError{StatusCode: http.StatusTeapot, Message: "teapot"},
			wantStatus: http.StatusInternalServerError,
			wantMsg:    "fallback",
		},
		{
			name:       "empty conflict message uses fallback",
			err:        &repohost.StatusError{StatusCode: http.StatusConflict},
			wantStatus: http.StatusConflict,
			wantMsg:    "fallback",
		},
		{
			name:       "unprocessable status is preserved",
			err:        &repohost.StatusError{StatusCode: http.StatusUnprocessableEntity, Message: "no path matched"},
			wantStatus: http.StatusUnprocessableEntity,
			wantMsg:    "no path matched",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			apiErr := repohostErrToAPIErr(context.Background(), tt.err, "fallback")

			require.NotNil(t, apiErr)
			assert.Equal(t, tt.wantStatus, apiErr.Status)
			assert.Equal(t, tt.wantMsg, apiErr.Message)
		})
	}
}

func TestJJVCS_Cov_ResolveRepositoryBranches(t *testing.T) {
	t.Parallel()

	t.Run("nil resolver returns internal", func(t *testing.T) {
		t.Parallel()
		handler := JJVCSHandler{}
		repo, apiErr := handler.resolveRepository(context.Background(), "alice", "demo")

		assert.Zero(t, repo.ID)
		require.NotNil(t, apiErr)
		assert.Equal(t, http.StatusInternalServerError, apiErr.Status)
	})

	t.Run("not found maps to 404", func(t *testing.T) {
		t.Parallel()
		handler := JJVCSHandler{RepoResolver: jjVCSCovResolver{
			fn: func(context.Context, db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
				return db.GetRepoByOwnerAndNameRow{}, pgx.ErrNoRows
			},
		}}
		repo, apiErr := handler.resolveRepository(context.Background(), "alice", "missing")

		assert.Zero(t, repo.ID)
		require.NotNil(t, apiErr)
		assert.Equal(t, http.StatusNotFound, apiErr.Status)
		assert.Equal(t, "repository not found", apiErr.Message)
	})

	t.Run("unexpected resolver error maps to internal", func(t *testing.T) {
		t.Parallel()
		handler := JJVCSHandler{RepoResolver: jjVCSCovResolver{
			fn: func(context.Context, db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
				return db.GetRepoByOwnerAndNameRow{}, stdErrors.New("database unavailable")
			},
		}}
		_, apiErr := handler.resolveRepository(context.Background(), "alice", "demo")

		require.NotNil(t, apiErr)
		assert.Equal(t, http.StatusInternalServerError, apiErr.Status)
	})
}

func TestJJVCS_Cov_BookmarkWriteBranches(t *testing.T) {
	t.Parallel()

	t.Run("create rejects invalid json", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			t.Fatal("repohost should not be called")
		}))
		t.Cleanup(server.Close)

		handler := newJJVCSHandler(server)
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/bookmarks", strings.NewReader(`{`))
		req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withRepoAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.CreateBookmark(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("create stops on resolver not found before repohost", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			t.Fatal("repohost should not be called")
		}))
		t.Cleanup(server.Close)

		handler := &JJVCSHandler{
			RepoHost: repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, "test-token", nil),
			RepoResolver: jjVCSCovResolver{
				fn: func(context.Context, db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
					return db.GetRepoByOwnerAndNameRow{}, pgx.ErrNoRows
				},
			},
		}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/bookmarks", strings.NewReader(`{"name":"main","target_change_id":"chg"}`))
		req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withRepoAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.CreateBookmark(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("create succeeds despite dispatcher enqueue failure", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, http.MethodPost, r.Method)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(repohost.Bookmark{Name: "main", TargetChangeID: "chg", TargetCommitID: "commit"})
		}))
		t.Cleanup(server.Close)

		handler := &JJVCSHandler{
			RepoHost: repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, "test-token", nil),
			RepoResolver: jjVCSCovResolver{
				fn: func(context.Context, db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
					return db.GetRepoByOwnerAndNameRow{ID: 44, Name: "demo"}, nil
				},
			},
			WebhookDispatcher: jjVCSCovDispatcher{err: stdErrors.New("queue down")},
		}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/bookmarks", strings.NewReader(`{"name":"main","target_change_id":"chg"}`))
		req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withRepoAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.CreateBookmark(rec, req)

		// The bookmark mutation has already committed on the repo host, so an
		// enqueue failure is logged best-effort and must not surface as a 500.
		assert.Equal(t, http.StatusCreated, rec.Code)
		assert.Contains(t, rec.Body.String(), `"name":"main"`)
	})

	t.Run("delete succeeds despite dispatcher enqueue failure", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, http.MethodDelete, r.Method)
			w.WriteHeader(http.StatusNoContent)
		}))
		t.Cleanup(server.Close)

		handler := &JJVCSHandler{
			RepoHost: repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, "test-token", nil),
			RepoResolver: jjVCSCovResolver{
				fn: func(context.Context, db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
					return db.GetRepoByOwnerAndNameRow{ID: 44, Name: "demo"}, nil
				},
			},
			WebhookDispatcher: jjVCSCovDispatcher{err: stdErrors.New("queue down")},
		}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/bookmarks/main", nil)
		req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "name": "main"})
		req = withRepoAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.DeleteBookmark(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
	})
}

func TestJJVCS_Cov_ReadHandlerErrorBranches(t *testing.T) {
	t.Parallel()

	t.Run("get change maps unauthorized repohost status", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"message":"token expired"}`))
		}))
		t.Cleanup(server.Close)
		handler := newJJVCSHandler(server)
		handler.ChangeService = mockChangeDetailService{getChangeFn: func(context.Context, int64, string, string, string) (services.ChangeDetailResponse, error) {
			return services.ChangeDetailResponse{}, pkgerrors.Unauthorized("repo-host authorization failed")
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/chg", nil)
		req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg"})
		rec := httptest.NewRecorder()
		handler.GetChange(rec, req)

		assert.Equal(t, http.StatusUnauthorized, rec.Code)
		assert.Contains(t, rec.Body.String(), "repo-host authorization failed")
		assert.NotContains(t, rec.Body.String(), "token expired")
	})

	t.Run("change diff maps forbidden repohost status", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"private"}`))
		}))
		t.Cleanup(server.Close)
		handler := newJJVCSHandler(server)
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/chg/diff", nil)
		req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg"})
		rec := httptest.NewRecorder()
		handler.GetChangeDiff(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
		assert.Contains(t, rec.Body.String(), "repo-host permission denied")
	})

	t.Run("change files map forbidden repohost status", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"private"}`))
		}))
		t.Cleanup(server.Close)
		handler := newJJVCSHandler(server)
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/chg/files", nil)
		req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg"})
		rec := httptest.NewRecorder()
		handler.GetChangeFiles(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("change conflicts use fallback for empty bad request message", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
		}))
		t.Cleanup(server.Close)
		handler := newJJVCSHandler(server)
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/chg/conflicts", nil)
		req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg"})
		rec := httptest.NewRecorder()
		handler.GetChangeConflicts(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "failed to get change conflicts")
	})

	t.Run("file at change trims blank catch all path", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			t.Fatal("repohost should not be called")
		}))
		t.Cleanup(server.Close)
		handler := newJJVCSHandler(server)
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/file/chg/%20", nil)
		req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg", "*": "   "})
		rec := httptest.NewRecorder()
		handler.GetFileAtChange(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "path is required")
	})

	t.Run("working tree status maps forbidden repohost status", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"private"}`))
		}))
		t.Cleanup(server.Close)
		handler := newJJVCSHandler(server)
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/status", nil)
		req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		handler.GetWorkingTreeStatus(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
		assert.Contains(t, rec.Body.String(), "repo-host permission denied")
	})
}
