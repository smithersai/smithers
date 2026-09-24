package compose

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services/alertregistry"
)

// alertLinearRouterForTest builds a router with the alert webhook + Linear
// integration paths enabled so buildRouter registers:
//   - the Basic-authenticated /api/internal/alerts/incident receiver and task-authenticated
//     /internal/alerts/incidents/{incident-id}/outcome callback,
//     driven by SMITHERS_ALERT_WEBHOOK_SIGNING_KEY + a non-nil queries; the
//     registryFn seam selects the loadAlertRegistry error vs success arm.
//   - the /auth/linear + /auth/linear/callback routes (main.go:1760-1762),
//     driven by cfg.FeatureFlags.Integrations + a non-nil linearHandler.
//
// queries selects the wiring arm under test: db.New(nil) reaches the alert
// incident service arm (queries != nil), while nil keeps the global API rate
// limiter on its in-memory store so authenticated /api requests can exercise
// scope gates without a database.
func alertLinearRouterForTest(t *testing.T, queries *db.Queries, registryFn func() (*alertregistry.Registry, error)) http.Handler {
	t.Helper()
	return alertLinearRouterForTestWithReadiness(t, queries, registryFn, true)
}

// alertLinearRouterForTestWithReadiness is alertLinearRouterForTest with the
// alertRemediationReady flag under the caller's control, so the
// remediation-disabled arm can be exercised.
func alertLinearRouterForTestWithReadiness(
	t *testing.T,
	queries *db.Queries,
	registryFn func() (*alertregistry.Registry, error),
	remediationReady bool,
) http.Handler {
	t.Helper()
	t.Setenv("SMITHERS_ALERT_WEBHOOK_SIGNING_KEY", "alert-signing-key")
	swapVar(t, &loadAlertRegistry, registryFn)

	cfg := testConfigAllFlagsOn()
	cfg.FeatureFlags.Integrations = true

	return buildRouter(
		cfg,
		queries,
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
		&routes.AdminRunnerHandler{},       // hosted composition marker
		nil,                                // adminUserHandler
		nil,                                // adminOrgHandler
		nil,                                // adminRepoHandler
		nil,                                // adminSystemHealthHandler
		nil,                                // adminSystemStatusHandler
		nil,                                // adminSystemCanariesHandler
		nil,                                // adminSystemIncidentsHandler
		nil,                                // adminSystemMetricsHandler
		nil,                                // adminGitHubAppHandler
		nil,                                // adminAuditHandler
		nil,                                // webhookHandler
		nil,                                // secretHandler
		nil,                                // providerConnectionHandler
		nil,                                // variableHandler
		nil,                                // billingHandler
		nil,                                // protectedBookmarkHandler
		nil,                                // commitStatusHandler
		nil,                                // lfsHandler
		nil,                                // jjVCSHandler
		nil,                                // agentInternalHandler
		nil,                                // agentSessionHandler
		nil,                                // agentSessionStreamHandler
		nil,                                // approvalsHandler
		nil,                                // branchLockHandler
		nil,                                // pushHookHandler
		nil,                                // canaryReportHandler
		nil,                                // workflowHandler
		nil,                                // workflowCacheHandler
		nil,                                // workflowArtifactHandler
		nil,                                // issueEventHandler
		nil,                                // workspaceHandler
		nil,                                // workspaceInternalHandler
		nil,                                // repoGatewayHandler
		nil,                                // anonSandboxHandler
		nil,                                // gitHubProxyHandler
		nil,                                // gitHubRepoListHandler
		nil,                                // gitHubUserReposHandler
		nil,                                // gitHubSyncedReposHandler
		nil,                                // gitHubImportHandler
		nil,                                // workspaceTerminalHandler
		nil,                                // telemetryHandler
		nil,                                // featureFlagHandler
		nil,                                // oauth2Handler
		&routes.LinearIntegrationHandler{}, // linearHandler != nil -> /auth/linear routes
		nil,                                // gitHubWebhookHandler
		nil,                                // smithersMetrics
		remediationReady,                   // alertRemediationReady
	)
}

// TestBuildRouter_AlertWebhookRegistrySuccess covers the loadAlertRegistry
// success arm (main.go:1299-1301) that wires the AlertIncidentService receiver,
// plus the /auth/linear integration routes (main.go:1760-1762). The registered
// alert receiver route responds (not 404).
func TestBuildRouter_F_AlertWebhookRegistrySuccess(t *testing.T) {
	router := alertLinearRouterForTest(t, db.New(nil), func() (*alertregistry.Registry, error) {
		return &alertregistry.Registry{}, nil
	})

	// The alert incident receiver route is registered (a valid path segment ->
	// not a 404 route-miss).
	req := httptest.NewRequest(http.MethodPost, "/api/internal/alerts/incident", nil)
	req.SetBasicAuth(routes.AlertWebhookBasicAuthUsername, "alert-signing-key")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.NotEqual(t, http.StatusNotFound, rec.Code)

	// The outcome route is mounted under task-token middleware, never under the
	// global inbound-alert HMAC path.
	req = httptest.NewRequest(http.MethodPost, "/internal/alerts/incidents/0.abcdef/outcome", strings.NewReader(`{"state":"failed"}`))
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)

	// The Linear OAuth start route is registered (under the /api route group).
	req = httptest.NewRequest(http.MethodGet, "/api/auth/linear", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.NotEqual(t, http.StatusNotFound, rec.Code)

	// The client-facing setup lookup uses the canonical /api/linear surface.
	req = httptest.NewRequest(http.MethodGet, "/api/linear/setup/setup-key", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.NotEqual(t, http.StatusNotFound, rec.Code)
}

// TestBuildRouter_AlertWebhookRegistryError covers the loadAlertRegistry error
// arm: inbound admission stays disabled, while task-scoped outcome callbacks
// remain mounted from the DB-only recorder.
func TestBuildRouter_F_AlertWebhookRegistryError(t *testing.T) {
	preserveSlog(t)
	router := alertLinearRouterForTest(t, db.New(nil), func() (*alertregistry.Registry, error) {
		return nil, errors.New("alert registry boom (F)")
	})

	req := httptest.NewRequest(http.MethodPost, "/api/internal/alerts/incident", nil)
	req.SetBasicAuth(routes.AlertWebhookBasicAuthUsername, "alert-signing-key")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.NotEqual(t, http.StatusNotFound, rec.Code)

	// Registry failure leaves the task-scoped outcome receiver unmounted, and the
	// old global-HMAC callback must never be exposed.
	req = httptest.NewRequest(
		http.MethodPost,
		"/api/internal/alerts/incident/legacy-token/outcome",
		strings.NewReader(`{"incident_id":"0.abcdef","state":"failed"}`),
	)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

// TestBuildRouter_F_IntegrationMutationsRequireWriteRepositoryScope pins the
// RequireScope gate on Linear and GitHub mirror mutations: a
// fine-grained token without write:repository must not be able to configure,
// delete, or sync integrations. queries is nil so the global API rate limiter
// stays in-memory for these authenticated requests.
func TestBuildRouter_F_IntegrationMutationsRequireWriteRepositoryScope(t *testing.T) {
	router := alertLinearRouterForTest(t, nil, func() (*alertregistry.Registry, error) {
		return &alertregistry.Registry{}, nil
	})

	requests := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/linear"},
		{http.MethodPost, "/api/integrations/linear"},
		{http.MethodDelete, "/api/integrations/linear/1"},
		{http.MethodPost, "/api/integrations/linear/1/sync"},
		{http.MethodPost, "/api/linear/1/sync"},
		{http.MethodPost, "/api/linear/1/ops/2/retry"},
		{http.MethodPost, "/api/repos/alice/demo/github/mirror/refs/refs%2Fheads%2Fmain/retry"},
	}

	for _, r := range requests {
		req := httptest.NewRequest(r.method, r.path, strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req = withRouterTokenAuth(req, middleware.ScopeReadRepository, middleware.ScopeReadUser)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code, "%s %s with read-only token must be rejected", r.method, r.path)
	}
}

// A deliberately fail-closed remediation worker (alertRemediation.enabled=false
// in Helm, the rollout default) used to leave AlertWebhookHandler.Receiver nil,
// so every Cloud Monitoring delivery got 503 "alert remediation worker is not
// ready" and the incident was dropped — production ran with no alert ingestion
// at all. The receiver must be wired regardless; only the enqueue is gated.
func TestBuildRouter_F_AlertReceiverWiredWhenRemediationNotReady(t *testing.T) {
	preserveSlog(t)
	router := alertLinearRouterForTestWithReadiness(
		t,
		db.New(nil),
		func() (*alertregistry.Registry, error) { return &alertregistry.Registry{}, nil },
		false,
	)

	req := httptest.NewRequest(
		http.MethodPost,
		"/api/internal/alerts/incident",
		strings.NewReader(`{"incident":{"incident_id":"0.abc","policy_name":"Smithers High Error Rate - prod","state":"closed"}}`),
	)
	req.SetBasicAuth(routes.AlertWebhookBasicAuthUsername, "alert-signing-key")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	require.NotEqual(t, http.StatusNotFound, rec.Code)
	require.NotEqual(t, http.StatusServiceUnavailable, rec.Code,
		"the incident receiver must stay wired when auto-remediation is disabled")
}
