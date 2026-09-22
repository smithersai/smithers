//go:build integration
// +build integration

package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

const repositoryJobApprovalBearer = "gateway-bearer"

type repositoryJobApprovalGateway struct {
	target services.RepoGatewayRelayTarget
}

func (g repositoryJobApprovalGateway) AuthorizeRelay(_ context.Context, gatewayID, bearer string) (services.RepoGatewayRelayTarget, error) {
	if gatewayID != "gateway" || bearer != repositoryJobApprovalBearer {
		return services.RepoGatewayRelayTarget{}, pkgerrors.Unauthorized("invalid gateway token")
	}
	return g.target, nil
}

func (g repositoryJobApprovalGateway) CallRepositoryJob(context.Context, services.RepoGatewayConnectionInput, string, string, json.RawMessage) (json.RawMessage, error) {
	return nil, fmt.Errorf("the approval routes never reach the workspace")
}

// repositoryJobApprovalMiddleware names every identity middleware this test can
// mount, in the order internal/compose/router.go may list it. The feature-flag gate
// and the per-repository quota are left out: neither resolves identity.
var repositoryJobApprovalMiddleware = []struct {
	source  string
	handler func(http.Handler) http.Handler
}{
	{"middleware.RequireMatchingRepositoryRestriction", middleware.RequireMatchingRepositoryRestriction},
	{"middleware.RejectRepositoryRestrictedToken", middleware.RejectRepositoryRestrictedToken},
}

// repositoryJobApprovalChain reads the mount out of internal/compose/router.go rather
// than restating it, so dropping a middleware from the route reddens this test
// instead of leaving the copy here to drift.
func repositoryJobApprovalChain(t *testing.T, mount string) []func(http.Handler) http.Handler {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	require.True(t, ok)
	source, err := os.ReadFile(filepath.Join(filepath.Dir(thisFile), "..", "compose", "router.go"))
	require.NoError(t, err)
	var mounted string
	for _, line := range strings.Split(string(source), "\n") {
		if strings.Contains(line, mount) {
			require.Empty(t, mounted, "internal/compose/router.go mounts %s more than once", mount)
			mounted = line
		}
	}
	require.NotEmpty(t, mounted, "internal/compose/router.go no longer mounts %s", mount)

	base := map[string][]func(http.Handler) http.Handler{
		"writeRepo...": {middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository),
			middleware.RequireRepoPermission(middleware.PermissionWrite)},
		"readRepo...": {middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository),
			middleware.RequireRepoPermission(middleware.PermissionRead)},
	}
	var chain []func(http.Handler) http.Handler
	for name, handlers := range base {
		if strings.Contains(mounted, name) {
			require.Nil(t, chain, "%s names two permission chains", mount)
			chain = append(chain, handlers...)
		}
	}
	require.NotNil(t, chain, "%s names no permission chain", mount)
	for _, candidate := range repositoryJobApprovalMiddleware {
		if strings.Contains(mounted, candidate.source) {
			chain = append(chain, candidate.handler)
		}
	}
	return chain
}

func repositoryJobApprovalServer(t *testing.T, queries *db.Queries, service *services.RepositoryJobService) *httptest.Server {
	t.Helper()
	handler := &RepoGatewayHandler{RepositoryJobs: service}
	r := chi.NewRouter()
	r.Use(middleware.AuthLoader(queries, config.AuthConfig{}))
	r.Put("/api/gateways/{gatewayID}/repository-jobs/{job}", handler.PutRepositoryJob)
	r.Route("/api/repos/{owner}/{repo}", func(r chi.Router) {
		r.Use(middleware.LoadRepoContext(queries))
		r.With(repositoryJobApprovalChain(t, `Post("/repository-jobs/{job}/approvals"`)...).
			Post("/repository-jobs/{job}/approvals", handler.PostRepositoryJobApproval)
		r.With(repositoryJobApprovalChain(t, `Get("/repository-jobs/{job}/approvals"`)...).
			Get("/repository-jobs/{job}/approvals", handler.GetRepositoryJobApprovals)
	})
	server := httptest.NewServer(r)
	t.Cleanup(server.Close)
	return server
}

func repositoryJobApprovalDo(t *testing.T, client *http.Client, method, url, bearer string, body any) (int, string) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, url, reader)
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	response, err := client.Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	text, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	return response.StatusCode, string(text)
}

// A flow trigger runs a plan a person approved. Every credential a workspace
// holds is minted as the repository owner with write:repository and repo:<id>,
// so without a restriction check on the route the coding host, a per-run agent
// token or a gateway push token stamps that person's approval itself and the
// human gate disappears from the chain (L36 1.6; the E6 row of the endpoint
// table reads "user session, repo write").
func TestRepositoryJobApprovalRefusesNonHumanCredentials(t *testing.T) {
	pool := setupRoutesIntegrationPool(t)
	queries := db.New(pool)
	ctx := context.Background()

	owner := routesIntegrationCreateUser(t, pool, "approvalowner")
	reader := routesIntegrationCreateUser(t, pool, "approvalreader")
	stranger := routesIntegrationCreateUser(t, pool, "approvalstranger")
	repo := routesIntegrationCreateRepo(t, pool, owner, "approvalpublic", true)
	sibling := routesIntegrationCreateRepo(t, pool, owner, "approvalsibling", true)
	repositoryJobsCollaborator(t, pool, repo, reader, "read")
	workspace := routesIntegrationCreateWorkspace(t, queries, pool, repo, owner, "gateway", time.Now())

	service := services.NewRepositoryJobService(queries, repositoryJobApprovalGateway{target: services.RepoGatewayRelayTarget{
		GatewayID: "gateway", RepositoryID: repo.ID, UserID: owner.ID, WorkspaceID: workspace.ID}}, pool)
	server := repositoryJobApprovalServer(t, queries, service)

	envelope := json.RawMessage(`{"capabilities":["read","write"],"flows":["nightly-lint"],"budget":{"tokens":12000,"milliseconds":600000}}`)
	approval := func(digest string) map[string]any {
		return map[string]any{"plan_id": "plan-01", "plan_digest": digest, "flow_id": "nightly-lint", "envelope": envelope}
	}
	approvals := func(target routesIntegrationRepo) string {
		return server.URL + "/api/repos/" + target.Owner + "/" + target.Name + "/repository-jobs/flow:nightly-lint/approvals"
	}
	bound := func(scopes ...string) string {
		return repositoryJobsToken(t, pool, owner, strings.Join(scopes, ","))
	}

	agentDigest := strings.Repeat("3", 64)
	// The three credential classes a workspace holds, all minted as the owner:
	// the coding host's landing token, a per-run agent API token, and a push
	// token any gateway-bearer holder can mint.
	codingHost := bound(append([]string{"write:repository", middleware.RepositoryRestrictionScope(repo.ID)},
		middleware.PathRestrictionScopes([]string{"**"})...)...)
	perRun := bound("write:repository", middleware.RepositoryRestrictionScope(repo.ID),
		middleware.AgentSessionRestrictionScope("session-01"))
	push := bound("write:repository", middleware.RepositoryRestrictionScope(repo.ID))
	crossRepository := bound("write:repository", middleware.RepositoryRestrictionScope(sibling.ID))

	readerClient := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, reader))
	strangerClient := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, stranger))
	ownerClient := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, owner))

	for _, row := range []struct {
		caller string
		method string
		client *http.Client
		bearer string
		body   any
		status int
	}{
		{"same-repository coding-host token", http.MethodPost, server.Client(), codingHost, approval(agentDigest), http.StatusForbidden},
		{"per-run agent API token", http.MethodPost, server.Client(), perRun, approval(strings.Repeat("5", 64)), http.StatusForbidden},
		{"gateway push token", http.MethodPost, server.Client(), push, approval(strings.Repeat("6", 64)), http.StatusForbidden},
		{"gateway bearer", http.MethodPost, server.Client(), repositoryJobApprovalBearer, approval(strings.Repeat("1", 64)), http.StatusUnauthorized},
		{"anonymous", http.MethodPost, server.Client(), "", approval(strings.Repeat("1", 64)), http.StatusUnauthorized},
		{"read-only collaborator session", http.MethodPost, readerClient, "", approval(strings.Repeat("1", 64)), http.StatusForbidden},
		{"stranger session on a public repository", http.MethodPost, strangerClient, "", approval(strings.Repeat("1", 64)), http.StatusForbidden},
		{"token bound to another repository", http.MethodPost, server.Client(), crossRepository, approval(strings.Repeat("1", 64)), http.StatusForbidden},
		{"token bound to another repository, reading", http.MethodGet, server.Client(), crossRepository, nil, http.StatusForbidden},
	} {
		t.Run(row.caller, func(t *testing.T) {
			status, body := repositoryJobApprovalDo(t, row.client, row.method, approvals(repo), row.bearer, row.body)
			require.Equal(t, row.status, status, body)
		})
	}

	var rows int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_job_approvals`).Scan(&rows))
	require.Zero(t, rows, "a refused caller wrote an approval row")

	t.Run("owner session", func(t *testing.T) {
		status, body := repositoryJobApprovalDo(t, ownerClient, http.MethodPost, approvals(repo), "", approval(strings.Repeat("2", 64)))
		require.Equal(t, http.StatusOK, status, body)
		var recorded services.RepositoryJobApproval
		require.NoError(t, json.Unmarshal([]byte(body), &recorded))
		require.Equal(t, owner.ID, recorded.ApprovedBy)
	})

	// The shape the Worker relays for E11: the person's own unrestricted token.
	t.Run("owner's unrestricted user token", func(t *testing.T) {
		status, body := repositoryJobApprovalDo(t, server.Client(), http.MethodPost, approvals(repo),
			bound("read:repository", "write:repository"), approval(strings.Repeat("4", 64)))
		require.Equal(t, http.StatusOK, status, body)
	})

	// E7 is a read of the provenance, not a stamp of it, so a repository-bound
	// credential keeps the reader's view: the restriction check bounds it to
	// this repository and the wire carries no envelope.
	t.Run("read-only collaborator session reading", func(t *testing.T) {
		status, body := repositoryJobApprovalDo(t, readerClient, http.MethodGet, approvals(repo), "", nil)
		require.Equal(t, http.StatusOK, status, body)
		require.NotContains(t, body, "capabilities")
		var listed []services.RepositoryJobApproval
		require.NoError(t, json.Unmarshal([]byte(body), &listed))
		require.Len(t, listed, 2)
	})

	// Nothing downstream can launder the refusal: E1 admits only a plan some
	// person approved, and the agent's digest was never recorded.
	t.Run("registration naming the refused approval", func(t *testing.T) {
		registration := map[string]any{"repo": strings.ToLower(repo.Owner) + "/" + strings.ToLower(repo.Name),
			"workspace_id": workspace.ID, "flow_id": "nightly-lint", "revision": 1, "digest": strings.Repeat("a", 64),
			"source_revision": strings.Repeat("b", 40), "execution_digest": strings.Repeat("c", 64), "envelope": envelope,
			"mode": "enabled", "events": []any{}, "schedule": "0 9 * * 1-5", "input": map[string]any{"label": "nightly"},
			"approved_plan_id": "plan-01", "approved_plan_digest": agentDigest}
		status, body := repositoryJobApprovalDo(t, server.Client(), http.MethodPut,
			server.URL+"/api/gateways/gateway/repository-jobs/flow:nightly-lint", repositoryJobApprovalBearer, registration)
		require.Equal(t, http.StatusConflict, status, body)
		require.Contains(t, body, "register only the plan a person approved")
		var registrations int
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT count(*) FROM repository_job_registrations WHERE job = 'flow:nightly-lint'`).Scan(&registrations))
		require.Zero(t, registrations, "a refused registration wrote a row")
	})
}
