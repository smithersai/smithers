package compose

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// adminSystemConsoleRouterForTest builds the API router with the four admin
// system console handlers wired and everything else nil, so the assertions below
// only exercise route registration and the admin middleware chain.
func adminSystemConsoleRouterForTest() http.Handler {
	return buildRouter(
		testConfigAllFlagsOn(),
		nil, // queries
		nil, // pool
		&routes.RepoHandler{},
		nil, // mirrorSyncHandler
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		nil, // deployKeyHandler
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		nil,
		nil, // buildCacheHandler
		nil, // stackHandler
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // notificationHandler
		nil, // pairSessionHandler
		// subscriptionHandler
		&routes.RunnerHandler{Service: &mockRouterRunnerService{}},
		nil,                                   // adminRunnerHandler
		nil,                                   // adminUserHandler
		nil,                                   // adminOrgHandler
		nil,                                   // adminRepoHandler
		nil,                                   // adminSystemHealthHandler
		&routes.AdminSystemStatusHandler{},    // adminSystemStatusHandler
		&routes.AdminSystemCanariesHandler{},  // adminSystemCanariesHandler
		&routes.AdminSystemIncidentsHandler{}, // adminSystemIncidentsHandler
		&routes.AdminSystemMetricsHandler{},   // adminSystemMetricsHandler
		nil,                                   // adminGitHubAppHandler
		nil,                                   // adminAuditHandler
		nil,                                   // webhookHandler
		nil,                                   // secretHandler
		nil,                                   // providerConnectionHandler
		nil,                                   // variableHandler
		nil,                                   // billingHandler
		nil,                                   // protectedBookmarkHandler
		nil,                                   // commitStatusHandler
		nil,                                   // lfsHandler
		nil,                                   // jjVCSHandler
		nil,                                   // agentInternalHandler
		nil,                                   // agentSessionHandler
		nil,                                   // agentSessionStreamHandler
		nil,                                   // approvalsHandler
		nil,                                   // branchLockHandler
		nil,                                   // pushHookHandler
		nil,                                   // canaryReportHandler
		nil,                                   // workflowHandler
		nil,                                   // workflowCacheHandler
		nil,                                   // workflowArtifactHandler
		nil,                                   // issueEventHandler
		nil,                                   // workspaceHandler
		nil,                                   // workspaceInternalHandler
		nil,                                   // repoGatewayHandler
		nil,                                   // anonSandboxHandler
		nil,                                   // gitHubProxyHandler
		nil,                                   // gitHubRepoListHandler
		nil,                                   // gitHubUserReposHandler
		nil,                                   // gitHubSyncedReposHandler
		nil,                                   // gitHubImportHandler
		nil,                                   // workspaceTerminalHandler
		nil,                                   // telemetryHandler
		nil,                                   // featureFlagHandler
		nil,                                   // oauth2Handler
		nil,                                   // linearHandler
		nil,                                   // gitHubWebhookHandler
		nil,                                   // smithersMetrics
	)
}

// TestServerRouter_AdminSystemConsoleRoutesRegistered verifies each admin system
// console endpoint is mounted behind the admin middleware chain: an
// unauthenticated request is rejected with 401 rather than missing the route.
func TestServerRouter_AdminSystemConsoleRoutesRegistered(t *testing.T) {
	t.Parallel()

	router := adminSystemConsoleRouterForTest()

	paths := []string{
		"/api/admin/system/status",
		"/api/admin/system/canaries",
		"/api/admin/system/incidents",
		"/api/admin/system/metrics/query",
	}

	for _, path := range paths {
		path := path
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			assert.NotEqual(t, http.StatusNotFound, rec.Code, "GET %s must be registered", path)
			assert.Equal(t, http.StatusUnauthorized, rec.Code, "unauthenticated GET %s must return 401", path)
		})
	}
}

// TestServerRouter_AdminSystemConsoleRoutesAbsentWhenHandlersNil verifies every
// console route is nil-guarded like the other admin mounts. Production always
// supplies a metrics handler — a backend-less one when no GCP project is
// configured — so the 501 "metrics backend not configured" response is served by
// the handler, not by a route that only exists sometimes.
func TestServerRouter_AdminSystemConsoleRoutesAbsentWhenHandlersNil(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil) // every admin system console handler is nil

	for _, path := range []string{
		"/api/admin/system/status",
		"/api/admin/system/canaries",
		"/api/admin/system/incidents",
		"/api/admin/system/metrics/query",
	} {
		path := path
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusNotFound, rec.Code, "GET %s should be absent when its handler is nil", path)
		})
	}
}

// TestAdminSystemMetricsHandler_UnconfiguredBackendReturns501 covers the wiring
// main.go performs when no metrics project is configured: a handler with no
// backend, mounted so the endpoint reports "not configured" rather than 404.
func TestAdminSystemMetricsHandler_UnconfiguredBackendReturns501(t *testing.T) {
	t.Parallel()

	assert.Nil(t, routes.NewAdminSystemMetricsHandler("", nil),
		"no project id means no metrics backend")

	req := httptest.NewRequest(http.MethodGet, "/api/admin/system/metrics/query?name=http_request_rate", nil)
	rec := httptest.NewRecorder()
	(&routes.AdminSystemMetricsHandler{}).Query(rec, req)

	assert.Equal(t, http.StatusNotImplemented, rec.Code)
	assert.Contains(t, rec.Body.String(), "metrics backend not configured")
}

func TestServerRouter_AdminIncidentActionsRegistered(t *testing.T) {
	router := adminSystemConsoleRouterForTest()
	for _, path := range []string{"/api/admin/system/incidents/1/acknowledge", "/api/admin/system/incidents/1/unacknowledge", "/api/admin/system/incidents/1/resolve", "/api/admin/system/incidents/1/snooze", "/api/admin/system/incidents/bulk"} {
		t.Run(path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, nil))
			assert.Equal(t, http.StatusUnauthorized, rec.Code)
		})
	}
}

func TestServerRouter_AdminIncidentActionsRequireWriteScope(t *testing.T) {
	router := adminSystemConsoleRouterForTest()
	for _, path := range []string{"/api/admin/system/incidents/1/acknowledge", "/api/admin/system/incidents/1/unacknowledge", "/api/admin/system/incidents/1/resolve", "/api/admin/system/incidents/1/snooze", "/api/admin/system/incidents/bulk"} {
		for _, tc := range []struct {
			name   string
			admin  bool
			scope  middleware.TokenScope
			status int
		}{
			{"read admin", true, middleware.ScopeReadAdmin, http.StatusForbidden},
			{"non admin", false, middleware.ScopeWriteAdmin, http.StatusForbidden},
			// The intentionally unconfigured handler answers 500 only after passing
			// both the administrator check and the write scope gate.
			{"write admin", true, middleware.ScopeWriteAdmin, http.StatusInternalServerError},
		} {
			t.Run(path+tc.name, func(t *testing.T) {
				req := httptest.NewRequest(http.MethodPost, path, nil)
				req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 1, Username: "operator", IsAdmin: tc.admin}, Scopes: middleware.ScopeSet{tc.scope: struct{}{}}, IsTokenAuth: true}))
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, req)
				assert.Equal(t, tc.status, rec.Code)
			})
		}
	}
}
