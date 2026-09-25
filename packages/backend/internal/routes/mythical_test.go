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
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type fakeMythicalRoute struct {
	bootstraps []string
	main       string
}

func (f *fakeMythicalRoute) Snapshot(_ context.Context, id int64, slug, main string) (services.MythicalStackView, error) {
	f.main = main
	state := "absent"
	if len(f.bootstraps) > 0 {
		state = "bootstrapping"
	}
	return services.MythicalStackView{Repository: slug, State: state, Changes: []services.MythicalChangeView{},
		Items: []services.MythicalItemView{}, Lanes: []services.MythicalLaneView{}, Limits: services.MythicalLimitsView{MaxParallel: 2}}, nil
}

func (f *fakeMythicalRoute) RequestBootstrap(_ context.Context, id, actor int64, depth int32, reset bool) (db.MythicalStack, error) {
	f.bootstraps = append(f.bootstraps, strings.Join([]string{"repo", "depth", "reset"}, ":"))
	return db.MythicalStack{RepositoryID: id, ActorUserID: actor, BootstrapDepth: depth, ResetRequested: reset}, nil
}

func TestMythicalRoutes(t *testing.T) {
	service := &fakeMythicalRoute{}
	handler := &MythicalHandler{Service: service, MainHead: func(context.Context, string, string, string) (string, error) {
		return "abc", nil
	}}
	withRepo := func(r *http.Request, user bool) *http.Request {
		ctx := middleware.ContextWithRepoContext(r.Context(), &middleware.RepoContext{Owner: "smithers-canary",
			Repository: &db.Repository{ID: 19, Name: "smithers", DefaultBookmark: "main"}}, middleware.PermissionAdmin)
		if user {
			ctx = context.WithValue(ctx, middleware.UserContextKey, &db.User{ID: 7})
		}
		return r.WithContext(ctx)
	}

	rec := httptest.NewRecorder()
	handler.GetStack(rec, withRepo(httptest.NewRequest(http.MethodGet, "/", nil), false))
	require.Equal(t, http.StatusOK, rec.Code)
	var view map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &view))
	assert.Equal(t, "absent", view["state"])
	assert.Equal(t, "smithers-canary/smithers", view["repository"])
	assert.Contains(t, rec.Body.String(), `"mainBehind":false`)
	assert.Contains(t, rec.Body.String(), `"limits":{"maxParallel":2}`)
	assert.Equal(t, "abc", service.main)

	rec = httptest.NewRecorder()
	handler.Bootstrap(rec, withRepo(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"depth":50}`)), false))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)

	rec = httptest.NewRecorder()
	handler.Bootstrap(rec, withRepo(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"depth":900}`)), true))
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	rec = httptest.NewRecorder()
	handler.Bootstrap(rec, withRepo(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"unknown":1}`)), true))
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Empty(t, service.bootstraps)

	rec = httptest.NewRecorder()
	handler.Bootstrap(rec, withRepo(httptest.NewRequest(http.MethodPost, "/", nil), true))
	require.Equal(t, http.StatusAccepted, rec.Code)
	assert.Len(t, service.bootstraps, 1)
	assert.Contains(t, rec.Body.String(), `"state":"bootstrapping"`)
}
