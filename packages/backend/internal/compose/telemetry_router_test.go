package compose

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// telemetryTestBody is a valid POST /api/telemetry/errors request body.
const telemetryTestBody = `{"client":"web","version":"1.0","error":{"message":"x","stack":"","type":"TypeError"},"context":{}}`

// TestServerRouter_TelemetryGatedByFeatureFlag covers issue #323: the
// telemetry ingestion route must be gated on
// feature_flags.client_error_reporting so operators can disable client error
// ingestion entirely. When the flag is off, the route must 403 before the
// handler runs (proven by the counter staying at zero); when the flag is on,
// the existing 204 + metrics-increment behavior is preserved.
func TestServerRouter_TelemetryGatedByFeatureFlag(t *testing.T) {
	t.Parallel()

	t.Run("flag off: 403 and not ingested", func(t *testing.T) {
		t.Parallel()

		metrics := routes.NewSmithersMetrics()
		cfg := testConfigAllFlagsOn()
		cfg.FeatureFlags.ClientErrorReporting = false

		router := buildRouterCompat(
			cfg,
			nil, // queries
			nil, // pool
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
			&routes.TelemetryHandler{Metrics: metrics},
			nil, // featureFlagHandler
			nil, // oauth2Handler
			metrics,
		)

		req := httptest.NewRequest(http.MethodPost, "/api/telemetry/errors", strings.NewReader(telemetryTestBody))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
		assert.Contains(t, rec.Body.String(), "feature not available")
		assert.Equal(t, float64(0), testutil.ToFloat64(metrics.ClientErrorsTotal.WithLabelValues("web", "TypeError")))
	})

	t.Run("flag on: 204 and ingested", func(t *testing.T) {
		t.Parallel()

		metrics := routes.NewSmithersMetrics()
		cfg := testConfigAllFlagsOn()
		cfg.FeatureFlags.ClientErrorReporting = true

		router := buildRouterCompat(
			cfg,
			nil, // queries
			nil, // pool
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
			&routes.TelemetryHandler{Metrics: metrics},
			nil, // featureFlagHandler
			nil, // oauth2Handler
			metrics,
		)

		req := httptest.NewRequest(http.MethodPost, "/api/telemetry/errors", strings.NewReader(telemetryTestBody))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		assert.Equal(t, float64(1), testutil.ToFloat64(metrics.ClientErrorsTotal.WithLabelValues("web", "TypeError")))
	})
}
