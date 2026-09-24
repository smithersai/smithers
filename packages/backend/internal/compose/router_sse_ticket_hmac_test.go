package compose

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/sseauth"
)

// recordingRouterDB answers like adminManageRouterDB and records the sqlc
// query names it served.
type recordingRouterDB struct {
	adminManageRouterDB
	mu    sync.Mutex
	names []string
}

func (d *recordingRouterDB) QueryRow(ctx context.Context, query string, args ...any) pgx.Row {
	name := query
	if rest, ok := strings.CutPrefix(query, "-- name: "); ok {
		name, _, _ = strings.Cut(rest, " ")
	}
	d.mu.Lock()
	d.names = append(d.names, name)
	d.mu.Unlock()
	return d.adminManageRouterDB.QueryRow(ctx, query, args...)
}

func (d *recordingRouterDB) served() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.names...)
}

// With a database, tickets are minted and redeemed only through the shared
// single-use store. The process-local HMAC manager issues nothing there, so a
// router built with queries must not accept HMAC tickets either: that path
// skips the store's single-use and suspension checks.
func TestServerRouter_DatabaseRouterRejectsHMACTickets(t *testing.T) {
	t.Parallel()

	manager := sseauth.NewSSETicketManager("session-secret")
	ticket, _, err := manager.Issue(sseauth.SSETicketSubject{UserID: 1})
	require.NoError(t, err)

	store := &recordingRouterDB{}
	notifHandler := &routes.NotificationHandler{Service: &mockRouterNotificationService{}}
	router := buildRouterCompat(
		testConfigAllFlagsOn(),
		db.New(store),
		nil, // pool
		&routes.RepoHandler{},
		&routes.AuthHandler{SSETickets: manager},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		notifHandler,
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
		nil, // smithersMetrics
	)

	req := httptest.NewRequest(http.MethodGet, "/api/notifications?ticket="+ticket, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.NotContains(t, store.served(), "GetUserByID",
		"an HMAC ticket must not be validated against the user table on a database router")
}
