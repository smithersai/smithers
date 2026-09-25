package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type fakeMainPullRoute struct{ requested []int64 }

func (f *fakeMainPullRoute) Request(_ context.Context, id int64) (services.GitHubMainPullStatus, error) {
	f.requested = append(f.requested, id)
	return services.GitHubMainPullStatus{State: "pending", Pending: true}, nil
}

func (f *fakeMainPullRoute) Status(context.Context, int64) (services.GitHubMainPullStatus, error) {
	return services.GitHubMainPullStatus{State: "synced", Fresh: true, GitHubHead: "g", SmithersHead: "g"}, nil
}

func TestGitHubMainPullRoutes(t *testing.T) {
	service := &fakeMainPullRoute{}
	handler := &GitHubMainPullHandler{Service: service}
	withRepo := func(r *http.Request, user bool) *http.Request {
		ctx := middleware.ContextWithRepoContext(r.Context(), &middleware.RepoContext{Repository: &db.Repository{ID: 19}}, middleware.PermissionWrite)
		if user {
			ctx = context.WithValue(ctx, middleware.UserContextKey, &db.User{ID: 7})
		}
		return r.WithContext(ctx)
	}

	rec := httptest.NewRecorder()
	handler.GetMainPull(rec, withRepo(httptest.NewRequest(http.MethodGet, "/", nil), false))
	require.Equal(t, http.StatusOK, rec.Code)
	var status services.GitHubMainPullStatus
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &status))
	assert.True(t, status.Fresh)

	rec = httptest.NewRecorder()
	handler.RequestMainPull(rec, withRepo(httptest.NewRequest(http.MethodPost, "/", nil), false))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Empty(t, service.requested)

	rec = httptest.NewRecorder()
	handler.RequestMainPull(rec, withRepo(httptest.NewRequest(http.MethodPost, "/", nil), true))
	assert.Equal(t, http.StatusAccepted, rec.Code)
	assert.Equal(t, []int64{19}, service.requested)
}
