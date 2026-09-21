package compose

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// TestServerRouter_PanicIsCountedInHTTPMetrics pins release-review finding
// R004 at the production boundary: buildRouter mounts JSONRecoverer OUTSIDE
// HTTPMetrics, so a handler panic used to unwind past the metrics increment
// and the 500 the recoverer wrote never reached smithers_http_requests_total.
// The request travels the real /api stack (JSONTimeout, CORS, content-type,
// body limits, auth loader, CSRF, rate limit) before it panics.
func TestServerRouter_PanicIsCountedInHTTPMetrics(t *testing.T) {
	t.Setenv("SMITHERS_METRICS_TOKEN", "test-metrics-token")
	t.Setenv("SMITHERS_ENABLE_E2E_TEST_ROUTES", "true") // mounts GET /api/_test/panic

	metrics := routes.NewSmithersMetrics()
	router := buildRouterCompat(
		testConfigAllFlagsOn(),
		nil,
		nil,
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // notificationHandler
		&routes.RunnerHandler{Service: &mockRouterRunnerService{}},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminRepoHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		metrics,
	)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/_test/panic", nil))
	require.Equal(t, http.StatusInternalServerError, rec.Code, "JSONRecoverer answers the panic with 500")
	assert.Contains(t, rec.Body.String(), "internal server error")

	scrape := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	scrape.Header.Set("Authorization", "Bearer test-metrics-token")
	scrapeRec := httptest.NewRecorder()
	router.ServeHTTP(scrapeRec, scrape)
	require.Equal(t, http.StatusOK, scrapeRec.Code)

	body := scrapeRec.Body.String()
	assert.Contains(t, body, `smithers_http_requests_total{method="GET",path="/api/_test/panic",status="500"} 1`,
		"the recovered panic must be counted as the 500 the client received")
	assert.Contains(t, body, `smithers_http_request_duration_seconds_count{method="GET",path="/api/_test/panic"} 1`,
		"the recovered panic must still observe request duration")
}
