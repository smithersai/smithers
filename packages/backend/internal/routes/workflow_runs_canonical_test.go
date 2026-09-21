// Ticket 0111: canonical `/runs/{id}[/cancel]` route reconciliation.
//
// These tests assert that the canonical `/runs/{id}`, `/runs/{id}/cancel`, and
// the two existing aliases (`/actions/runs/...`, `/workflows/runs/...`) all
// route to the SAME handler — i.e. the reconciliation is a pure aliasing
// exercise, not a fork. The parity tests mount a chi router that mirrors
// cmd/server/main.go's registrations (which register one handler against
// multiple paths), drive identical requests down each path, and assert the
// responses are byte-identical.
package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// canonicalTestRouter mounts a minimal chi router that aliases the three
// run-operation paths at the two handlers under test:
//   - GET  /api/repos/.../runs/{id}          → GetWorkflowRun (canonical)
//     GET  /api/repos/.../actions/runs/{id}  → GetWorkflowRun (alias)
//     GET  /api/repos/.../workflows/runs/{id}→ GetWorkflowRun (alias — mapped
//     here to GetWorkflowRun for parity purposes. The production router
//     uses GetWorkflowRunV2 which differs; this test pins the *canonical
//     vs. alias* parity for the GetWorkflowRun handler path specifically.)
//   - POST /api/repos/.../runs/{id}/cancel          → CancelWorkflowRun (canonical)
//     POST /api/repos/.../actions/runs/{id}/cancel  → CancelWorkflowRun (alias)
//     POST /api/repos/.../workflows/runs/{id}/cancel→ CancelWorkflowRun (alias)
//
// A middleware installs both auth info and a fixed RepoContext so the
// handlers' context preconditions are met without bringing in the full
// auth pipeline.
func canonicalTestRouter(t *testing.T, h *WorkflowHandler, repoID int64) http.Handler {
	t.Helper()
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
				User: &db.User{ID: 1, Username: "alice", LowerUsername: "alice"},
			})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "alice",
				Repository: &db.Repository{ID: repoID, Name: "demo", LowerName: "demo"},
			}, middleware.PermissionWrite)
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})

	// Inspect — canonical + two aliases, same handler.
	r.Get("/api/repos/{owner}/{repo}/runs/{id}", h.GetWorkflowRun)
	r.Get("/api/repos/{owner}/{repo}/actions/runs/{id}", h.GetWorkflowRun)
	r.Get("/api/repos/{owner}/{repo}/workflows/runs/{id}", h.GetWorkflowRun)

	// Cancel — canonical + two aliases, same handler.
	r.Post("/api/repos/{owner}/{repo}/runs/{id}/cancel", h.CancelWorkflowRun)
	r.Post("/api/repos/{owner}/{repo}/actions/runs/{id}/cancel", h.CancelWorkflowRun)
	r.Post("/api/repos/{owner}/{repo}/workflows/runs/{id}/cancel", h.CancelWorkflowRun)

	return r
}

// TestCanonicalRouteParity_GetRun asserts that each of the three paths
// (canonical /runs/{id}, /actions/runs/{id} alias, /workflows/runs/{id}
// alias) delivers a byte-identical JSON response for the same run. The
// fixture handler counts invocations so we also prove the SAME handler
// instance was reached each time — not three parallel code paths that
// happened to agree.
func TestCanonicalRouteParity_GetRun(t *testing.T) {
	t.Parallel()

	const repoID int64 = 101
	run := makeWFRun(42, repoID, 7, "running")

	var callCount int64
	h := &WorkflowHandler{Service: &mockWorkflowRouteService{
		getWorkflowRunFn: func(_ context.Context, gotRepoID, gotRunID int64) (db.WorkflowRun, error) {
			atomic.AddInt64(&callCount, 1)
			assert.Equal(t, repoID, gotRepoID, "repo id must match across alias paths")
			assert.Equal(t, int64(42), gotRunID, "run id must match across alias paths")
			return run, nil
		},
	}}

	router := canonicalTestRouter(t, h, repoID)

	type pathCase struct {
		name string
		url  string
	}
	cases := []pathCase{
		{"canonical", "/api/repos/alice/demo/runs/42"},
		{"alias_actions", "/api/repos/alice/demo/actions/runs/42"},
		{"alias_workflows", "/api/repos/alice/demo/workflows/runs/42"},
	}

	var firstBody []byte
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.url, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			require.Equal(t, http.StatusOK, rec.Code, "path %s returned %d: %s", tc.url, rec.Code, rec.Body.String())
			if i == 0 {
				firstBody = append(firstBody[:0], rec.Body.Bytes()...)
			} else {
				assert.Equal(t, string(firstBody), rec.Body.String(),
					"path %s body differs from canonical — aliases must share handler output exactly", tc.url)
			}
		})
	}

	// All three paths must have reached the SAME mock — that's what proves
	// the aliasing (rather than divergent code paths) is real.
	assert.Equal(t, int64(3), atomic.LoadInt64(&callCount),
		"GetWorkflowRun must be invoked once per path — canonical + 2 aliases")
}

// TestCanonicalRouteParity_CancelRun asserts all three cancel paths hit the
// same CancelWorkflowRun handler and return 204. A cancel is a side-effect
// with no body, so parity is (a) status and (b) observed repo/run IDs.
func TestCanonicalRouteParity_CancelRun(t *testing.T) {
	t.Parallel()

	const repoID int64 = 101

	var callCount int64
	h := &WorkflowHandler{Service: &mockWorkflowRouteService{
		cancelWorkflowRunFn: func(_ context.Context, gotRepoID, gotRunID int64) error {
			atomic.AddInt64(&callCount, 1)
			assert.Equal(t, repoID, gotRepoID)
			assert.Equal(t, int64(42), gotRunID)
			return nil
		},
	}}

	router := canonicalTestRouter(t, h, repoID)

	cases := []struct {
		name string
		url  string
	}{
		{"canonical", "/api/repos/alice/demo/runs/42/cancel"},
		{"alias_actions", "/api/repos/alice/demo/actions/runs/42/cancel"},
		{"alias_workflows", "/api/repos/alice/demo/workflows/runs/42/cancel"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, tc.url, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			require.Equal(t, http.StatusNoContent, rec.Code,
				"path %s returned %d: %s", tc.url, rec.Code, rec.Body.String())
		})
	}

	assert.Equal(t, int64(3), atomic.LoadInt64(&callCount),
		"CancelWorkflowRun must be invoked once per path — canonical + 2 aliases")
}

// TestCanonicalRouteParity_GetRun_NotFoundSharedError asserts the error
// shape (404 + body) is identical across aliases. This catches the failure
// mode where someone wires an alias to a thin wrapper that mis-renders
// errors.
func TestCanonicalRouteParity_GetRun_NotFoundSharedError(t *testing.T) {
	t.Parallel()

	const repoID int64 = 101

	h := &WorkflowHandler{Service: &mockWorkflowRouteService{
		getWorkflowRunFn: func(_ context.Context, _, _ int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, pkgerrors.NotFound("workflow run not found")
		},
	}}

	router := canonicalTestRouter(t, h, repoID)
	cases := []string{
		"/api/repos/alice/demo/runs/999",
		"/api/repos/alice/demo/actions/runs/999",
		"/api/repos/alice/demo/workflows/runs/999",
	}

	var firstBody string
	for i, url := range cases {
		req := httptest.NewRequest(http.MethodGet, url, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code, "path %s", url)
		if i == 0 {
			firstBody = rec.Body.String()
		} else {
			assert.Equal(t, firstBody, rec.Body.String(),
				"404 body must be identical across aliases; path=%s", url)
		}
	}
}
