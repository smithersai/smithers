package compose

import (
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"testing"
)

func browserOriginRouter(cfg *config.Config) http.Handler {
	return buildRouterCompat(
		cfg,
		nil,
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
		&routes.GitSmartHandler{},
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
		nil,
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
		nil, // smithersMetrics
	)
}

func TestRouterCanonicalBrowserAuthOrigin(t *testing.T) {
	cfg := testConfigAllFlagsOn()
	cfg.Auth.GitHubClientID = "configured-client"
	cfg.Auth.GitHubRedirectURL = "https://app.example/api/auth/github/callback"
	server := httptest.NewServer(browserOriginRouter(cfg))
	defer server.Close()
	client := server.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	for _, path := range []string{"/api/auth/github?return_to=%2Fowner%2Frepo", "/api/auth/github/cli?callback_port=41523", "/api/oauth2/authorize?client_id=fixture&state=bound"} {
		t.Run(path, func(t *testing.T) {
			response, err := client.Get(server.URL + path)
			require.NoError(t, err)
			defer response.Body.Close()
			require.Equal(t, http.StatusFound, response.StatusCode)
			require.Equal(t, "https://app.example"+path, response.Header.Get("Location"))
			require.Empty(t, response.Cookies(), "host-only state must be placed only after reaching the callback origin")
		})
	}
}
