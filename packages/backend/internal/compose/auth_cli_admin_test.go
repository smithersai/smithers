package compose

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type routerCLIAdminService struct{ *mockRouterAuthService }

func (*routerCLIAdminService) StartAdminCLILogin(context.Context, string, string, int, string, string) (string, error) {
	return "", fmt.Errorf("unexpected OAuth start")
}
func (*routerCLIAdminService) PrepareAdminCLIConsent(context.Context, services.OAuthCallbackResult, string, string) (services.AdminCLIConsent, error) {
	return services.AdminCLIConsent{}, fmt.Errorf("unexpected OAuth callback")
}
func (*routerCLIAdminService) ApproveAdminCLILogin(_ context.Context, state, verifier, csrf, ip string) (services.AdminCLILoginResult, error) {
	if state != "state" || verifier != "verifier" || csrf != "csrf" {
		return services.AdminCLILoginResult{}, pkgerrors.Forbidden("invalid consent")
	}
	expires := time.Now().Add(time.Hour)
	return services.AdminCLILoginResult{Request: services.AdminCLIRequest{CallbackPort: 4321}, Token: services.CreateTokenResult{Token: "smithers_test_admin", TokenSummary: services.TokenSummary{ExpiresAt: &expires}}}, nil
}

func adminCLIConsentTestRouter(authHandler *routes.AuthHandler) http.Handler {
	return buildRouterCompat(
		testConfigAllFlagsOn(),
		nil,
		nil, // pool
		&routes.RepoHandler{},
		authHandler,
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // notificationHandler — pool is nil so SSE would 500; fine for non-SSE tests
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

func TestServerRouter_AdminCLIConsentForm(t *testing.T) {
	router := adminCLIConsentTestRouter(&routes.AuthHandler{Service: &routerCLIAdminService{&mockRouterAuthService{}}})
	for _, tc := range []struct {
		form, verifier string
		status         int
	}{{"state=state&csrf_token=csrf&decision=approve", "verifier", 302}, {"state=state&decision=approve", "verifier", 403}, {"state=state&csrf_token=csrf&decision=approve", "", 403}, {"state=state", "verifier", 400}} {
		req := httptest.NewRequest("POST", "/api/auth/github/cli/consent", strings.NewReader(tc.form))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.AddCookie(&http.Cookie{Name: "smithers_oauth_state", Value: tc.verifier})
		// A pre-existing browser session must not interfere with verifier-based
		// consent or force the HTML form through JSON-only API middleware.
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "old-browser-session"})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		require.Equal(t, tc.status, rec.Code, rec.Body.String())
		if tc.status == 302 {
			require.Contains(t, rec.Header().Get("Location"), "127.0.0.1:4321/callback#")
		}
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest("GET", "/api/auth/github/cli/consent", nil))
	require.Equal(t, 200, rec.Code)
	require.Contains(t, rec.Body.String(), "No token was created")
}
