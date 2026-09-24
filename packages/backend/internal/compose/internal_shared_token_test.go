package compose

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// buildInternalAuthTestRouter builds a router with runner-pool and workspace
// internal handlers wired, using the given shared agent token via env.
func buildInternalAuthTestRouter(t *testing.T, sharedToken string) http.Handler {
	t.Helper()
	t.Setenv("SMITHERS_AGENT_TOKEN", sharedToken)

	return buildRouterCompat(
		testCORSConfig(),
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
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
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
		&routes.WorkspaceInternalHandler{Service: &mockIntegrationWorkspaceInternalService{}},
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)
}

// Regression (IDOR): runner-pool lifecycle routes and the workspace status
// callback operate purely on IDs from the URL with no per-run scoping, so they
// must only accept the shared runner pod credential — never the per-run agent
// tokens handed to untrusted sandboxes.
func TestWorkspaceStatus_RejectsPerRunTokens(t *testing.T) {
	const sharedToken = "shared-runner-pod-token"
	// A syntactically valid per-run agent token (smithers_agent_ + 40 hex).
	const perRunToken = "smithers_agent_0123456789abcdef0123456789abcdef01234567"

	router := buildInternalAuthTestRouter(t, sharedToken)

	endpoints := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodPost, "/internal/workspace/ws-1/status", `{"status":"running"}`},
	}

	for _, ep := range endpoints {
		// Per-run agent token must be rejected.
		req := httptest.NewRequest(ep.method, ep.path, strings.NewReader(ep.body))
		req.Header.Set("Authorization", "Bearer "+perRunToken)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusUnauthorized, rec.Code,
			"%s %s must reject per-run agent tokens", ep.method, ep.path)

		// A wrong shared token must be rejected too.
		req = httptest.NewRequest(ep.method, ep.path, strings.NewReader(ep.body))
		req.Header.Set("Authorization", "Bearer wrong-token")
		req.Header.Set("Content-Type", "application/json")
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusUnauthorized, rec.Code,
			"%s %s must reject unknown tokens", ep.method, ep.path)

		// The shared pod credential is accepted (route reachable, not 401/404).
		req = httptest.NewRequest(ep.method, ep.path, strings.NewReader(ep.body))
		req.Header.Set("Authorization", "Bearer "+sharedToken)
		req.Header.Set("Content-Type", "application/json")
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		require.NotEqual(t, http.StatusUnauthorized, rec.Code,
			"%s %s must accept the shared pod credential", ep.method, ep.path)
		require.NotEqual(t, http.StatusNotFound, rec.Code,
			"%s %s must be registered", ep.method, ep.path)
	}
}

// When no shared token is configured, the routes fail safe (401 for everyone).
func TestWorkspaceStatus_FailsSafeWithoutSharedToken(t *testing.T) {
	router := buildInternalAuthTestRouter(t, "")

	req := httptest.NewRequest(http.MethodPost, "/internal/workspace/ws-1/status", strings.NewReader(`{"status":"running"}`))
	req.Header.Set("Authorization", "Bearer anything")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}
