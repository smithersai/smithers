package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

type stubUserReposQuerier struct {
	countFn func(ctx context.Context, userID int64) (int64, error)
	listFn  func(ctx context.Context, arg db.ListReadableReposForUserParams) ([]db.ListReadableReposForUserRow, error)
}

func (s *stubUserReposQuerier) CountReadableReposForUser(ctx context.Context, userID int64) (int64, error) {
	if s.countFn != nil {
		return s.countFn(ctx, userID)
	}
	return 0, nil
}

func (s *stubUserReposQuerier) ListReadableReposForUser(ctx context.Context, arg db.ListReadableReposForUserParams) ([]db.ListReadableReposForUserRow, error) {
	if s.listFn != nil {
		return s.listFn(ctx, arg)
	}
	return nil, nil
}

func TestUserReposHandler_ListUserRepos(t *testing.T) {
	t.Parallel()

	handler := NewUserReposHandler(&stubUserReposQuerier{
		countFn: func(ctx context.Context, userID int64) (int64, error) {
			assert.Equal(t, int64(7), userID)
			return 3, nil
		},
		listFn: func(ctx context.Context, arg db.ListReadableReposForUserParams) ([]db.ListReadableReposForUserRow, error) {
			assert.Equal(t, int64(7), arg.UserID)
			assert.Equal(t, int32(0), arg.PageOffset)
			assert.Equal(t, int32(2), arg.PageSize)
			return []db.ListReadableReposForUserRow{
				{
					ID:    42,
					Owner: "alice",
					Name:  "demo",
				},
				{
					ID:    43,
					Owner: "acme",
					Name:  "tools",
				},
			}, nil
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/api/user/repos?limit=2", nil)
	req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, &db.User{
		ID:       7,
		Username: "alice",
	}))
	rec := httptest.NewRecorder()

	handler.ListUserRepos(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Header().Get("Link"), `rel="next"`)
	assert.Contains(t, rec.Header().Get("Link"), "page=2")
	assert.Contains(t, rec.Header().Get("Link"), "per_page=2")

	var body userReposEnvelope
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
	require.Len(t, body.Repos, 2)
	assert.Equal(t, userRepoRow{
		ID:           42,
		RepositoryID: 42,
		Owner:        "alice",
		RepoOwner:    "alice",
		Name:         "demo",
		RepoName:     "demo",
		FullName:     "alice/demo",
	}, body.Repos[0])
	assert.Equal(t, "acme/tools", body.Repos[1].FullName)
}

func TestUserReposHandler_ListUserReposRequiresAuth(t *testing.T) {
	t.Parallel()

	handler := NewUserReposHandler(&stubUserReposQuerier{})
	req := httptest.NewRequest(http.MethodGet, "/api/user/repos", nil)
	rec := httptest.NewRecorder()

	handler.ListUserRepos(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, strings.ToLower(rec.Body.String()), "authentication required")
}
