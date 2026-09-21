package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestUserRepos_Cov_ErrorBranches(t *testing.T) {
	t.Parallel()

	t.Run("invalid pagination is rejected before query", func(t *testing.T) {
		called := false
		h := NewUserReposHandler(&stubUserReposQuerier{
			countFn: func(context.Context, int64) (int64, error) {
				called = true
				return 0, nil
			},
		})
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/user/repos?page=0", nil), 7, "alice")
		rec := httptest.NewRecorder()

		h.ListUserRepos(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.False(t, called)
	})

	t.Run("count error propagates", func(t *testing.T) {
		h := NewUserReposHandler(&stubUserReposQuerier{
			countFn: func(context.Context, int64) (int64, error) {
				return 0, pkgerrors.Forbidden("repo list denied")
			},
		})
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/user/repos", nil), 7, "alice")
		rec := httptest.NewRecorder()

		h.ListUserRepos(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
		assert.Contains(t, rec.Body.String(), "repo list denied")
	})

	t.Run("list error propagates after count", func(t *testing.T) {
		h := NewUserReposHandler(&stubUserReposQuerier{
			countFn: func(context.Context, int64) (int64, error) {
				return 4, nil
			},
			listFn: func(context.Context, db.ListReadableReposForUserParams) ([]db.ListReadableReposForUserRow, error) {
				return nil, pkgerrors.Internal("list failed")
			},
		})
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/user/repos", nil), 7, "alice")
		rec := httptest.NewRecorder()

		h.ListUserRepos(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		// #267: writeRouteError sanitizes 5xx bodies; "list failed" is logged
		// server-side, not returned to the client.
		assert.Contains(t, rec.Body.String(), "internal server error")
	})
}
