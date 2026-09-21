package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type manageRouteFake struct {
	calls     int
	err       error
	agent     db.AdminListAgentSessionsParams
	workspace db.AdminListWorkspacesParams
	token     db.AdminListTokensParams
	reason    string
	hours     int32
}

func (f *manageRouteFake) ListAgentSessions(_ context.Context, p db.AdminListAgentSessionsParams) ([]services.AdminAgentSession, error) {
	f.calls++
	f.agent = p
	return []services.AdminAgentSession{}, f.err
}
func (f *manageRouteFake) CancelAgentSession(_ context.Context, id, reason string) (services.AdminManageStatus, error) {
	f.calls++
	f.reason = reason
	return services.AdminManageStatus{ID: id, Status: "cancelled"}, f.err
}
func (f *manageRouteFake) ListWorkspaces(_ context.Context, p db.AdminListWorkspacesParams) ([]services.AdminWorkspace, error) {
	f.calls++
	f.workspace = p
	return []services.AdminWorkspace{}, f.err
}
func (f *manageRouteFake) StopWorkspace(_ context.Context, id string) (services.AdminManageStatus, error) {
	f.calls++
	return services.AdminManageStatus{ID: id, Status: "stopped"}, f.err
}
func (f *manageRouteFake) SuspendWorkspace(_ context.Context, id string) (services.AdminManageStatus, error) {
	f.calls++
	return services.AdminManageStatus{ID: id, Status: "suspended"}, f.err
}
func (f *manageRouteFake) ListSandboxHosts(context.Context) ([]services.AdminSandboxHost, error) {
	f.calls++
	return []services.AdminSandboxHost{}, f.err
}
func (f *manageRouteFake) DrainSandboxHost(_ context.Context, id string) (services.AdminHostState, error) {
	f.calls++
	return services.AdminHostState{ID: id, State: "draining"}, f.err
}
func (f *manageRouteFake) PruneStaleSandboxHosts(_ context.Context, h int32) (services.AdminPruneResult, error) {
	f.calls++
	f.hours = h
	return services.AdminPruneResult{Pruned: 2}, f.err
}
func (f *manageRouteFake) ListTokens(_ context.Context, p db.AdminListTokensParams) ([]services.AdminToken, error) {
	f.calls++
	f.token = p
	return []services.AdminToken{}, f.err
}
func manageTestRouter(f *manageRouteFake) http.Handler {
	r := chi.NewRouter()
	a := &AdminAgentSessionHandler{f}
	w := &AdminWorkspaceHandler{f}
	h := &AdminSandboxHostHandler{f}
	tokens := &AdminTokenHandler{f}
	r.Get("/agent-sessions", a.List)
	r.Post("/agent-sessions/{id}/cancel", a.Cancel)
	r.Get("/workspaces", w.List)
	r.Post("/workspaces/{id}/stop", w.Stop)
	r.Post("/workspaces/{id}/suspend", w.Suspend)
	r.Get("/sandbox/hosts", h.List)
	r.Post("/sandbox/hosts/{id}/drain", h.Drain)
	r.Post("/sandbox/hosts/prune-stale", h.PruneStale)
	r.Get("/tokens", tokens.List)
	return r
}
func TestAdminManageHandlers(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	for _, tt := range []struct{ method, path, body, want string }{
		{"GET", "/agent-sessions?status=all&include_synthetic=true&limit=200", "", "[]"},
		{"POST", "/agent-sessions/" + id + "/cancel", `{"reason":"operator"}`, `{"id":"` + id + `","status":"cancelled"}`},
		{"GET", "/workspaces?status=failed&kind=agent&owner=owner&include_synthetic=true&limit=200", "", "[]"},
		{"POST", "/workspaces/" + id + "/stop", "", `{"id":"` + id + `","status":"stopped"}`},
		{"POST", "/workspaces/" + id + "/suspend", "", `{"id":"` + id + `","status":"suspended"}`},
		{"GET", "/sandbox/hosts", "", "[]"},
		{"POST", "/sandbox/hosts/worker/drain", "", `{"id":"worker","state":"draining"}`},
		{"POST", "/sandbox/hosts/prune-stale", "", `{"pruned":2}`},
		{"GET", "/tokens?unused_days=30&scope=read:admin&expiring_days=7&limit=500", "", "[]"},
	} {
		t.Run(tt.path, func(t *testing.T) {
			f := &manageRouteFake{}
			router := manageTestRouter(f)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest(tt.method, tt.path, strings.NewReader(tt.body)))
			require.Equal(t, 200, rec.Code, rec.Body.String())
			require.JSONEq(t, tt.want, rec.Body.String())
			require.Equal(t, 1, f.calls)
			if strings.HasPrefix(tt.path, "/agent-sessions?") {
				require.Equal(t, "all", f.agent.Status)
				require.True(t, f.agent.IncludeSynthetic)
				require.EqualValues(t, 200, f.agent.RowLimit)
			}
			if strings.HasPrefix(tt.path, "/workspaces?") {
				require.Equal(t, "owner", f.workspace.Owner)
				require.Equal(t, "agent", f.workspace.Kind)
				require.Equal(t, "failed", f.workspace.Status)
			}
			if strings.HasPrefix(tt.path, "/tokens?") {
				require.EqualValues(t, 30, f.token.UnusedDays)
				require.EqualValues(t, 7, f.token.ExpiringDays)
				require.Equal(t, "read:admin", f.token.Scope)
			}
			if tt.path == "/sandbox/hosts/prune-stale" {
				require.EqualValues(t, 24, f.hours)
			}
			f.err = pkgerrors.Conflict("invalid transition")
			rec = httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest(tt.method, tt.path, strings.NewReader(tt.body)))
			require.Equal(t, 409, rec.Code)
		})
	}
}
func TestAdminManageHandlersRejectMalformedInput(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	for _, tt := range []struct{ method, path, body string }{
		{"GET", "/agent-sessions?limit=201", ""}, {"GET", "/agent-sessions?limit=0", ""}, {"GET", "/agent-sessions?include_synthetic=yes", ""},
		{"GET", "/workspaces?limit=no", ""}, {"GET", "/workspaces?include_synthetic=1", ""}, {"GET", "/tokens?limit=501", ""}, {"GET", "/tokens?unused_days=-1", ""}, {"GET", "/tokens?expiring_days=x", ""}, {"GET", "/tokens?limit=1&limit=2", ""},
		{"POST", "/agent-sessions/bad/cancel", ""}, {"POST", "/workspaces/bad/stop", ""}, {"POST", "/workspaces/bad/suspend", ""},
		{"POST", "/agent-sessions/" + id + "/cancel", `{"unknown":1}`}, {"POST", "/agent-sessions/" + id + "/cancel", `{} {}`}, {"POST", "/agent-sessions/" + id + "/cancel", `null`}, {"POST", "/agent-sessions/" + id + "/cancel", `{"reason":"` + strings.Repeat("x", 9000) + `"}`},
		{"POST", "/sandbox/hosts/prune-stale", `{"older_than_hours":0}`}, {"POST", "/sandbox/hosts/prune-stale", `{"older_than_hours":-1}`}, {"POST", "/sandbox/hosts/prune-stale", `{"older_than_hours":1.5}`},
	} {
		t.Run(tt.path+tt.body[:min(len(tt.body), 20)], func(t *testing.T) {
			f := &manageRouteFake{}
			rec := httptest.NewRecorder()
			manageTestRouter(f).ServeHTTP(rec, httptest.NewRequest(tt.method, tt.path, strings.NewReader(tt.body)))
			require.Equal(t, 400, rec.Code, rec.Body.String())
			require.Zero(t, f.calls)
		})
	}
}
