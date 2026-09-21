package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

func TestRepoOwnerAndName_FromRepoContext(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil)
	repository := &db.Repository{ID: 1, Name: "demo", LowerName: "demo"}
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Owner:      "alice",
		Repository: repository,
	}, middleware.PermissionRead)
	req = req.WithContext(ctx)

	owner, repo, err := repoOwnerAndName(req)
	require.NoError(t, err)
	assert.Equal(t, "alice", owner)
	assert.Equal(t, "demo", repo)
}

func TestRepoOwnerAndName_FromRouteParams(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})

	owner, repo, err := repoOwnerAndName(req)
	require.NoError(t, err)
	assert.Equal(t, "alice", owner)
	assert.Equal(t, "demo", repo)
}

func TestRepoOwnerAndName_MissingOwnerRouteParam(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/api/repos//demo", nil)
	req = withRouteParams(req, map[string]string{"repo": "demo"})

	_, _, err := repoOwnerAndName(req)
	require.Error(t, err)
}

func TestRepoOwnerAndName_MissingRepoRouteParam(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice"})

	_, _, err := repoOwnerAndName(req)
	require.Error(t, err)
}

func TestRepoOwnerAndName_RepoContextPreferred(t *testing.T) {
	t.Parallel()

	// If both repo context and route params are set, repo context wins
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil)
	req = withRouteParams(req, map[string]string{"owner": "routeowner", "repo": "routerepo"})
	repository := &db.Repository{ID: 1, Name: "ctxrepo", LowerName: "ctxrepo"}
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Owner:      "ctxowner",
		Repository: repository,
	}, middleware.PermissionRead)
	req = req.WithContext(ctx)

	owner, repo, err := repoOwnerAndName(req)
	require.NoError(t, err)
	assert.Equal(t, "ctxowner", owner)
	assert.Equal(t, "ctxrepo", repo)
}
