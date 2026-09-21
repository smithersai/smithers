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
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func forkRequest(t *testing.T, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/fork", strings.NewReader(body))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	return withAuth(req, 9, "forker")
}

// The first fork answers 202: the repository row exists and the repo-host copy
// is still running.
func TestRepoHandler_ForkRepo_CreatedAnswersAccepted(t *testing.T) {
	h := RepoHandler{Service: mockRepoRouteService{
		forkOutcomeFn: func(_ context.Context, actor *db.User, owner, repo, name, _ string) (services.ForkOutcome, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			assert.Equal(t, "demo-fork", name)
			return services.ForkOutcome{
				Repository: routeRepo(func(r *db.Repository) {
					r.Name = "demo-fork"
					r.LowerName = "demo-fork"
					r.IsFork = true
				}),
				Created: true,
			}, nil
		},
	}}

	rec := httptest.NewRecorder()
	h.ForkRepo(rec, forkRequest(t, `{"name":"demo-fork"}`))

	require.Equal(t, http.StatusAccepted, rec.Code)
	var body RepoResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "forker/demo-fork", body.FullName)
	assert.True(t, body.CanWrite, "the whole point of a fork is a namespace the caller can write in")
	require.NotNil(t, body.ForkOf)
	assert.Equal(t, "alice/demo", *body.ForkOf)
}

// The second fork answers 200 with the same repository. A repeated click
// navigates to the fork the caller already has; it never makes a second one.
func TestRepoHandler_ForkRepo_ExistingForkAnswersOKWithTheSameRepository(t *testing.T) {
	h := RepoHandler{Service: mockRepoRouteService{
		forkOutcomeFn: func(context.Context, *db.User, string, string, string, string) (services.ForkOutcome, error) {
			return services.ForkOutcome{
				Repository: routeRepo(func(r *db.Repository) {
					r.ID = 4242
					r.Name = "demo"
					r.LowerName = "demo"
					r.IsFork = true
				}),
				Created: false,
			}, nil
		},
	}}

	rec := httptest.NewRecorder()
	h.ForkRepo(rec, forkRequest(t, `{}`))

	require.Equal(t, http.StatusOK, rec.Code)
	var body RepoResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, int64(4242), body.ID)
	assert.Equal(t, "forker/demo", body.FullName)
}

// A writer's fork is refused with a code the UI can branch on, so it hides the
// fork offer rather than showing a button that always fails.
func TestRepoHandler_ForkRepo_WriterIsRefusedWithForkNotNeeded(t *testing.T) {
	h := RepoHandler{Service: mockRepoRouteService{
		forkOutcomeFn: func(context.Context, *db.User, string, string, string, string) (services.ForkOutcome, error) {
			return services.ForkOutcome{}, errors.New(errors.CodeForkNotNeeded,
				"you already have write access to alice/demo; edit it directly instead of forking it")
		},
	}}

	rec := httptest.NewRecorder()
	h.ForkRepo(rec, forkRequest(t, `{}`))

	require.Equal(t, http.StatusForbidden, rec.Code)
	var body errors.APIError
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, errors.CodeForkNotNeeded, body.Code)
	assert.Contains(t, body.Message, "edit it directly")
}

// A repository read carries the viewer's write access and its upstream, so a
// client decides between "edit" and "fork" from the answer instead of guessing.
func TestRepoHandler_GetRepo_CarriesCanWriteAndForkOf(t *testing.T) {
	for _, tc := range []struct {
		name   string
		view   services.RepoView
		expect func(*testing.T, RepoResponse)
	}{
		{
			name: "reader on an upstream",
			view: services.RepoView{Repository: routeRepo(nil)},
			expect: func(t *testing.T, body RepoResponse) {
				assert.False(t, body.CanWrite)
				assert.Nil(t, body.ForkOf)
			},
		},
		{
			name: "writer on their own fork",
			view: services.RepoView{
				Repository: routeRepo(func(r *db.Repository) { r.IsFork = true }),
				CanWrite:   true,
				ForkOf:     "alice/demo",
			},
			expect: func(t *testing.T, body RepoResponse) {
				assert.True(t, body.CanWrite)
				require.NotNil(t, body.ForkOf)
				assert.Equal(t, "alice/demo", *body.ForkOf)
			},
		},
	} {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			view := tc.view
			h := RepoHandler{Service: mockRepoRouteService{
				getRepoViewFn: func(context.Context, *db.User, string, string) (services.RepoView, error) {
					return view, nil
				},
			}}

			req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil)
			req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
			rec := httptest.NewRecorder()
			h.GetRepo(rec, req)

			require.Equal(t, http.StatusOK, rec.Code)
			var body RepoResponse
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			tc.expect(t, body)
		})
	}
}

// can_write is never omitted: a client that cannot see the field would have to
// assume one answer, and the safe assumption (no write access) is the one that
// hides a maintainer's own edit buttons.
func TestRepoHandler_GetRepo_AlwaysSerializesCanWrite(t *testing.T) {
	h := RepoHandler{Service: mockRepoRouteService{
		getRepoViewFn: func(context.Context, *db.User, string, string) (services.RepoView, error) {
			return services.RepoView{Repository: routeRepo(nil)}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()
	h.GetRepo(rec, req)

	var raw map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &raw))
	value, present := raw["can_write"]
	require.True(t, present, "can_write must be on the wire even when it is false")
	assert.Equal(t, false, value)
}
