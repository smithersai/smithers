package compose

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

func adminManageRouterForTest() http.Handler {
	return buildRouter(
		testConfigAllFlagsOn(),
		db.New(adminManageRouterDB{}), // queries
		nil,                           // pool
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
		nil, // pairHandler
		nil, // pairSessionHandler
		// subscriptionHandler
		&routes.RunnerHandler{Service: &mockRouterRunnerService{}},
		&routes.AdminRunnerHandler{},          // hosted composition marker
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
func TestAdminManageRouterGates(t *testing.T) {
	router := adminManageRouterForTest()
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/admin/agent-sessions"}, {"POST", "/api/admin/agent-sessions/11111111-1111-4111-8111-111111111111/cancel"},
		{"GET", "/api/admin/workspaces"}, {"POST", "/api/admin/workspaces/11111111-1111-4111-8111-111111111111/stop"}, {"POST", "/api/admin/workspaces/11111111-1111-4111-8111-111111111111/suspend"},
		{"GET", "/api/admin/sandbox/hosts"}, {"POST", "/api/admin/sandbox/hosts/worker/drain"}, {"POST", "/api/admin/sandbox/hosts/prune-stale"}, {"GET", "/api/admin/tokens"},
	} {
		t.Run(route.path, func(t *testing.T) {
			req := httptest.NewRequest(route.method, route.path, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			require.Equal(t, http.StatusUnauthorized, rec.Code)
			req = withRouterAdminTokenAuth(httptest.NewRequest(route.method, route.path, nil), false, middleware.TokenSourcePersonalAccessToken, middleware.ScopeWriteAdmin)
			rec = httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			require.Equal(t, http.StatusForbidden, rec.Code)
			scope := middleware.ScopeReadRepository
			if route.method == "POST" {
				scope = middleware.ScopeReadAdmin
			}
			req = withRouterAdminTokenAuth(httptest.NewRequest(route.method, route.path, nil), true, middleware.TokenSourcePersonalAccessToken, scope)
			rec = httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			require.Equal(t, http.StatusForbidden, rec.Code)
		})
	}
}

// The router's global rate limiter runs before the admin middleware.
type adminManageRouterDB struct{ db.DBTX }

func (adminManageRouterDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}
func (adminManageRouterDB) QueryRow(_ context.Context, query string, _ ...any) pgx.Row {
	return adminManageRouterRow{rateLimit: strings.Contains(query, "ConsumeSearchRateLimitToken")}
}

type adminManageRouterRow struct{ rateLimit bool }

func (r adminManageRouterRow) Scan(dest ...any) error {
	if !r.rateLimit {
		return pgx.ErrNoRows
	}
	*dest[0].(*bool) = true
	*dest[1].(*float64) = 1000
	*dest[2].(*time.Time) = time.Now()
	return nil
}
