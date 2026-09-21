package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func chiRepoRequest(owner, repo string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("owner", owner)
	rctx.URLParams.Add("repo", repo)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

// Repositories resolve case-insensitively (lower_name), so the per-repo quota
// bucket key must canonicalize case. Otherwise a client can multiply every
// per-repo quota by permuting the case of the owner/repo path segments.
func TestRepoBucketKeyIsCaseInsensitive(t *testing.T) {
	const scope = "repo_stack_submits"
	lower := repoBucketKey(chiRepoRequest("foo", "bar"), scope)
	upper := repoBucketKey(chiRepoRequest("FOO", "BAR"), scope)
	mixed := repoBucketKey(chiRepoRequest("Foo", "Bar"), scope)

	if lower != upper || lower != mixed {
		t.Fatalf("case variation produced different quota buckets: %q / %q / %q", lower, upper, mixed)
	}
	if want := "repo_stack_submits|repo:foo/bar"; lower != want {
		t.Fatalf("unexpected bucket key: got %q want %q", lower, want)
	}
}
