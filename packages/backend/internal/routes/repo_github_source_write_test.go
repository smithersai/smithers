package routes

import (
	"context"
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

// aliasedRequest builds a request that reached its repository the way repro
// apps/ui/canary-repros/github/13.7 did: the URL named GitHub source
// coordinates and repo_context resolved them, through the requester's own
// import provenance, to a mirror in the requester's namespace.
func aliasedRequest(method, target string, body string, params map[string]string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, params)
	repository := db.Repository{ID: 48, Name: "hello-world", LowerName: "hello-world"}
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Owner:             "codeplanesmithers",
		Repository:        &repository,
		GitHubSourceOwner: "octocat",
		GitHubSourceRepo:  "Hello-World",
	}, middleware.PermissionOwner)
	ctx = context.WithValue(ctx, middleware.UserContextKey, &db.User{ID: 9, Username: "codeplanesmithers"})
	return req.WithContext(ctx)
}

func directRequest(method, target string, body string, params map[string]string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, params)
	repository := db.Repository{ID: 48, Name: "hello-world", LowerName: "hello-world"}
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Owner:      "codeplanesmithers",
		Repository: &repository,
	}, middleware.PermissionOwner)
	ctx = context.WithValue(ctx, middleware.UserContextKey, &db.User{ID: 9, Username: "codeplanesmithers"})
	return req.WithContext(ctx)
}

// Repro apps/ui/canary-repros/github/13.7 — "fake success writing to a
// read-only repository". `/issues.create … octocat/Hello-World` answered a DONE
// card reading "Issue #3 — octocat/Hello-World … opened by codeplanesmithers"
// while github.com/octocat/Hello-World had no such issue: the write landed in
// the requester's private mirror, whose numbering restarts at #1 while the real
// repository is at #10897. An importable repository is not a writable one.
func TestIssueHandler_RefusesWritesAddressedByGitHubSourceCoordinates(t *testing.T) {
	t.Parallel()

	t.Run("creating an issue by GitHub coordinates is refused, not mirrored", func(t *testing.T) {
		t.Parallel()
		h := IssueHandler{Service: &mockIssueRouteService{
			createIssueFn: func(context.Context, *db.User, string, string, services.CreateIssueInput) (services.IssueResponse, error) {
				t.Fatal("the mirror must never be written through a GitHub source alias")
				return services.IssueResponse{}, nil
			},
		}}
		rec := httptest.NewRecorder()
		h.CreateIssue(rec, aliasedRequest(http.MethodPost, "/api/repos/octocat/Hello-World/issues",
			`{"title":"canary repro 13.7"}`, map[string]string{"owner": "octocat", "repo": "Hello-World"}))

		require.Equal(t, http.StatusConflict, rec.Code)
		body := rec.Body.String()
		// The refusal has to name the repository the user asked for, the mirror
		// it would really have written, and that github.com is not reached.
		assert.Contains(t, body, "octocat/Hello-World")
		assert.Contains(t, body, "codeplanesmithers/hello-world")
		assert.Contains(t, body, "never reach github.com")
	})

	t.Run("closing an issue by GitHub coordinates is refused", func(t *testing.T) {
		t.Parallel()
		h := IssueHandler{Service: &mockIssueRouteService{
			updateIssueFn: func(context.Context, *db.User, string, string, int64, services.UpdateIssueInput) (services.IssueResponse, error) {
				t.Fatal("the mirror must never be written through a GitHub source alias")
				return services.IssueResponse{}, nil
			},
		}}
		rec := httptest.NewRecorder()
		h.PatchIssue(rec, aliasedRequest(http.MethodPatch, "/api/repos/octocat/Hello-World/issues/1",
			`{"state":"closed"}`, map[string]string{"owner": "octocat", "repo": "Hello-World", "number": "1"}))
		require.Equal(t, http.StatusConflict, rec.Code)
	})

	t.Run("commenting by GitHub coordinates is refused", func(t *testing.T) {
		t.Parallel()
		h := IssueHandler{Service: &mockIssueRouteService{
			createIssueCommentFn: func(context.Context, *db.User, string, string, int64, services.CreateIssueCommentInput) (services.IssueCommentResponse, error) {
				t.Fatal("the mirror must never be written through a GitHub source alias")
				return services.IssueCommentResponse{}, nil
			},
		}}
		rec := httptest.NewRecorder()
		h.PostIssueComment(rec, aliasedRequest(http.MethodPost, "/api/repos/octocat/Hello-World/issues/1/comments",
			`{"body":"hi"}`, map[string]string{"owner": "octocat", "repo": "Hello-World", "number": "1"}))
		require.Equal(t, http.StatusConflict, rec.Code)
	})

	// The guard is about the ADDRESS, not the repository: writing to the same
	// mirror by its own Smithers coordinates is an ordinary, honest write.
	t.Run("the same repository addressed by its Smithers name still writes", func(t *testing.T) {
		t.Parallel()
		called := false
		h := IssueHandler{Service: &mockIssueRouteService{
			createIssueFn: func(_ context.Context, _ *db.User, owner, repo string, _ services.CreateIssueInput) (services.IssueResponse, error) {
				called = true
				assert.Equal(t, "codeplanesmithers", owner)
				assert.Equal(t, "hello-world", repo)
				return sampleIssueResponse(), nil
			},
		}}
		rec := httptest.NewRecorder()
		h.CreateIssue(rec, directRequest(http.MethodPost, "/api/repos/codeplanesmithers/hello-world/issues",
			`{"title":"a real local issue"}`, map[string]string{"owner": "codeplanesmithers", "repo": "hello-world"}))
		require.Equal(t, http.StatusCreated, rec.Code)
		assert.True(t, called)
	})

	// Reads legitimately follow the alias — that is what it exists for.
	t.Run("reading by GitHub coordinates still resolves", func(t *testing.T) {
		t.Parallel()
		h := IssueHandler{Service: &mockIssueRouteService{
			listIssuesFn: func(context.Context, *db.User, string, string, int64, int, string) ([]services.IssueResponse, string, int64, error) {
				return []services.IssueResponse{sampleIssueResponse()}, "", 1, nil
			},
		}}
		rec := httptest.NewRecorder()
		h.ListIssues(rec, aliasedRequest(http.MethodGet, "/api/repos/octocat/Hello-World/issues", "",
			map[string]string{"owner": "octocat", "repo": "Hello-World"}))
		require.Equal(t, http.StatusOK, rec.Code)
	})
}
