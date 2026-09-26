package compose

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/ports"
)

type routerManageStub struct{}

func (routerManageStub) ListAgentSessions(context.Context, db.AdminListAgentSessionsParams) ([]services.AdminAgentSession, error) {
	return []services.AdminAgentSession{}, nil
}
func (routerManageStub) CancelAgentSession(_ context.Context, id, _ string) (services.AdminManageStatus, error) {
	return services.AdminManageStatus{ID: id, Status: "cancelled"}, nil
}
func (routerManageStub) ListWorkspaces(context.Context, db.AdminListWorkspacesParams) ([]services.AdminWorkspace, error) {
	return []services.AdminWorkspace{}, nil
}
func (routerManageStub) StopWorkspace(_ context.Context, id string) (services.AdminManageStatus, error) {
	return services.AdminManageStatus{ID: id, Status: "stopped"}, nil
}
func (routerManageStub) SuspendWorkspace(_ context.Context, id string) (services.AdminManageStatus, error) {
	return services.AdminManageStatus{ID: id, Status: "suspended"}, nil
}
func (routerManageStub) ListTokens(context.Context, db.AdminListTokensParams) ([]services.AdminToken, error) {
	return []services.AdminToken{}, nil
}
func (routerManageStub) Summary(_ context.Context, rangeName string, include bool) (services.AnalyticsSummary, error) {
	return services.AnalyticsSummary{Range: rangeName, SyntheticExcluded: !include}, nil
}

type routerPingStub struct{}

func (routerPingStub) Ping(context.Context) error { return nil }

func adminManageRouterForTest(deployment ...ports.AdminRoute) http.Handler {
	return routerWithExtras(routerExtras{
		AdminSystemHealth:  &routes.AdminSystemHealthHandler{DB: routerPingStub{}},
		AdminAnalytics:     &routes.AdminAnalyticsHandler{Service: routerManageStub{}},
		AdminAgentSessions: &routes.AdminAgentSessionHandler{Service: routerManageStub{}},
		AdminWorkspaces:    &routes.AdminWorkspaceHandler{Service: routerManageStub{}},
		AdminTokens:        &routes.AdminTokenHandler{Service: routerManageStub{}},
		DeploymentAdmin:    deployment,
	})
}

// Every operator route sits behind the admin chain: anonymous callers get 401,
// non-admins and admins without the route's scope get 403.
func TestAdminManageRouterGates(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	deployment := []ports.AdminRoute{
		{Method: http.MethodGet, Pattern: "/fleet/hosts", Handler: func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }},
		{Method: http.MethodPost, Pattern: "/fleet/hosts/{id}/drain", Write: true, Handler: func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }},
	}
	router := adminManageRouterForTest(deployment...)
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/admin/system/health"}, {"GET", "/api/admin/analytics/summary"},
		{"GET", "/api/admin/agent-sessions"}, {"POST", "/api/admin/agent-sessions/" + id + "/cancel"},
		{"GET", "/api/admin/workspaces"}, {"POST", "/api/admin/workspaces/" + id + "/stop"}, {"POST", "/api/admin/workspaces/" + id + "/suspend"},
		{"GET", "/api/admin/tokens"}, {"GET", "/api/admin/fleet/hosts"}, {"POST", "/api/admin/fleet/hosts/worker/drain"},
	} {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			serve := func(req *http.Request) int {
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, req)
				return rec.Code
			}
			require.Equal(t, http.StatusUnauthorized, serve(httptest.NewRequest(route.method, route.path, nil)))
			require.Equal(t, http.StatusForbidden, serve(withRouterAdminTokenAuth(httptest.NewRequest(route.method, route.path, nil), false, middleware.TokenSourcePersonalAccessToken, middleware.ScopeWriteAdmin)))
			granted, missing := middleware.ScopeReadAdmin, middleware.ScopeReadRepository
			if route.method == "POST" {
				granted, missing = middleware.ScopeWriteAdmin, middleware.ScopeReadAdmin
			}
			require.Equal(t, http.StatusForbidden, serve(withRouterAdminTokenAuth(httptest.NewRequest(route.method, route.path, nil), true, middleware.TokenSourcePersonalAccessToken, missing)))
			require.Equal(t, http.StatusOK, serve(withRouterAdminTokenAuth(httptest.NewRequest(route.method, route.path, nil), true, middleware.TokenSourcePersonalAccessToken, granted)))
		})
	}
}

// Deployment handlers see the acting admin so their audited operations name them.
func TestDeploymentAdminRouteCarriesAuditActor(t *testing.T) {
	var actor services.AdminAuditActor
	var found bool
	router := adminManageRouterForTest(ports.AdminRoute{Method: http.MethodPost, Pattern: "/fleet/hosts/{id}/drain", Write: true, Handler: func(w http.ResponseWriter, r *http.Request) {
		actor, found = services.AdminAuditActorFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, withRouterAdminTokenAuth(httptest.NewRequest(http.MethodPost, "/api/admin/fleet/hosts/worker/drain", nil), true, middleware.TokenSourcePersonalAccessToken, middleware.ScopeWriteAdmin))
	require.Equal(t, http.StatusOK, rec.Code)
	require.True(t, found)
	require.NotZero(t, actor.UserID)
}

// Alert incidents, the Managed Prometheus proxy, and the runner pool are not
// product routes, and a deployment that mounts no sandbox fleet serves none.
func TestRetiredAdminRoutesAreNotServed(t *testing.T) {
	router := adminManageRouterForTest()
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/admin/system/incidents"}, {"POST", "/api/admin/system/incidents/1/acknowledge"}, {"POST", "/api/admin/system/incidents/bulk"},
		{"GET", "/api/admin/system/metrics/query"}, {"GET", "/api/admin/runners"},
		{"GET", "/api/admin/sandbox/hosts"}, {"POST", "/api/admin/sandbox/hosts/worker/drain"}, {"POST", "/api/admin/sandbox/hosts/prune-stale"},
	} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, withRouterAdminTokenAuth(httptest.NewRequest(route.method, route.path, nil), true, middleware.TokenSourcePersonalAccessToken, middleware.ScopeWriteAdmin))
		require.Contains(t, []int{http.StatusNotFound, http.StatusMethodNotAllowed}, rec.Code, route.path)
	}
}
