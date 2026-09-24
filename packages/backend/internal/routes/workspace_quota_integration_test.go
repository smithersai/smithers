//go:build integration
// +build integration

package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestWorkspaceRoutes_CreateQuotaBoundaryAndDeleteFreesSlot(t *testing.T) {
	pool := setupRoutesIntegrationPool(t)
	queries := db.New(pool)

	user := routesIntegrationCreateUser(t, pool, "workspace_quota_user")
	repoA := routesIntegrationCreateRepo(t, pool, user, "workspace_quota_repo_a", false)
	repoB := routesIntegrationCreateRepo(t, pool, user, "workspace_quota_repo_b", false)
	seeded := seedActiveForkWorkspaces(t, queries, repoA.ID, user.ID, 99)
	require.Len(t, seeded, 99)

	service := services.NewWorkspaceService(
		queries,
		services.WithWorkspaceGitBaseURL("http://smithers.test"),
		services.WithWorkspaceSandboxClient(&workspaceQuotaIntegrationSandbox{}),
	)
	server := setupWorkspaceQuotaIntegrationServer(t, queries, &WorkspaceHandler{Service: service})
	authClient := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, user))

	pathRepoB := fmt.Sprintf("/api/repos/%s/%s/workspaces", repoB.Owner, repoB.Name)
	// Browser-facing creation is asynchronous: the row (and therefore the quota
	// slot) is taken synchronously and the VM is provisioned afterwards, so the
	// route answers 202 Accepted with a still-starting workspace.
	hundredth := requireAcceptedWorkspaceCreate(t, authClient, server.URL, repoB, pathRepoB, `{"name":"ws-100"}`)

	count, err := queries.CountActiveWorkspacesByUser(context.Background(), user.ID)
	require.NoError(t, err)
	require.Equal(t, int64(100), count, "the 202 must have consumed the quota slot before it returned")

	requireWorkspaceProvisioned(t, queries, hundredth.ID)

	pathRepoA := fmt.Sprintf("/api/repos/%s/%s/workspaces", repoA.Owner, repoA.Name)
	resp := routesIntegrationDoRequest(t, authClient, server.URL, http.MethodPost, pathRepoA, []byte(`{"name":"ws-101"}`))
	require.Equal(t, http.StatusTooManyRequests, resp.StatusCode)

	var overLimit struct {
		Code    pkgerrors.Code `json:"code"`
		Message string         `json:"message"`
	}
	routesIntegrationDecodeJSON(t, resp, &overLimit)
	require.Equal(t, pkgerrors.CodeQuotaExceeded, overLimit.Code)
	require.Contains(t, overLimit.Message, "delete one to continue")

	deletePath := fmt.Sprintf("/api/repos/%s/%s/workspaces/%s", repoA.Owner, repoA.Name, seeded[0].ID)
	resp = routesIntegrationDoRequest(t, authClient, server.URL, http.MethodDelete, deletePath, nil)
	require.Equal(t, http.StatusNoContent, resp.StatusCode)
	_ = routesIntegrationReadBody(t, resp)

	deleted, err := queries.GetWorkspaceIncludingDeleted(context.Background(), seeded[0].ID)
	require.NoError(t, err)
	require.True(t, deleted.DeletedAt.Valid)
	require.Equal(t, "stopped", deleted.Status)

	count, err = queries.CountActiveWorkspacesByUser(context.Background(), user.ID)
	require.NoError(t, err)
	require.Equal(t, int64(99), count)

	refilled := requireAcceptedWorkspaceCreate(t, authClient, server.URL, repoA, pathRepoA, `{"name":"ws-after-delete"}`)
	require.NotEqual(t, seeded[0].ID, refilled.ID, "the freed slot must be refilled by a new workspace, not the tombstone")

	count, err = queries.CountActiveWorkspacesByUser(context.Background(), user.ID)
	require.NoError(t, err)
	require.Equal(t, int64(100), count)

	requireWorkspaceProvisioned(t, queries, refilled.ID)
}

// requireAcceptedWorkspaceCreate posts a workspace create and asserts the
// asynchronous creation contract exactly: 202 Accepted carrying a workspace row
// that exists, is owned by the route's repository, and has not been provisioned
// yet (status "starting", no VM bound).
func requireAcceptedWorkspaceCreate(
	t *testing.T,
	client *http.Client,
	serverURL string,
	repo routesIntegrationRepo,
	path string,
	body string,
) services.WorkspaceResponse {
	t.Helper()

	resp := routesIntegrationDoRequest(t, client, serverURL, http.MethodPost, path, []byte(body))
	require.Equal(t, http.StatusAccepted, resp.StatusCode)

	var created services.WorkspaceResponse
	routesIntegrationDecodeJSON(t, resp, &created)
	require.NotEmpty(t, created.ID)
	require.Equal(t, repo.ID, created.RepositoryID)
	require.Equal(t, "starting", created.Status)
	require.Empty(t, created.VMID, "202 means the VM is provisioned after the response, not before it")
	require.Equal(t, repo.Owner+"/"+repo.Name, created.RepoFullName)
	require.Equal(t, "/repos/"+repo.Owner+"/"+repo.Name+"/workspaces/"+created.ID, created.HTMLURL)
	return created
}

// requireWorkspaceProvisioned waits for the goroutine the 202 started to finish
// and asserts it really did bring the workspace up. Draining it also keeps the
// background writes from racing the pool teardown at the end of the test.
func requireWorkspaceProvisioned(t *testing.T, queries *db.Queries, workspaceID string) db.Workspace {
	t.Helper()

	deadline := time.Now().Add(30 * time.Second)
	for {
		workspace, err := queries.GetWorkspace(context.Background(), workspaceID)
		require.NoError(t, err)
		if workspace.Status != "starting" {
			require.Equal(t, "running", workspace.Status, "async provisioning must finish running, not %q", workspace.Status)
			require.NotEmpty(t, workspace.VmID, "a running workspace must be bound to a VM")
			return workspace
		}
		if time.Now().After(deadline) {
			t.Fatalf("workspace %s never left status starting", workspaceID)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestWorkspaceRoutes_ForkQuotaExceededAtCap(t *testing.T) {
	pool := setupRoutesIntegrationPool(t)
	queries := db.New(pool)

	user := routesIntegrationCreateUser(t, pool, "workspace_fork_quota_user")
	repo := routesIntegrationCreateRepo(t, pool, user, "workspace_fork_quota_repo", false)

	source, err := queries.CreateWorkspace(context.Background(), db.CreateWorkspaceParams{
		RepositoryID: repo.ID,
		UserID:       user.ID,
		Name:         "source",
		Status:       "running",
	})
	require.NoError(t, err)

	_, err = pool.Exec(context.Background(), `UPDATE workspaces SET vm_id = 'source-vm' WHERE id = $1`, source.ID)
	require.NoError(t, err)

	seedActiveForkWorkspaces(t, queries, repo.ID, user.ID, 99)

	count, err := queries.CountActiveWorkspacesByUser(context.Background(), user.ID)
	require.NoError(t, err)
	require.Equal(t, int64(100), count)

	service := services.NewWorkspaceService(
		queries,
		services.WithWorkspaceGitBaseURL("http://smithers.test"),
		services.WithWorkspaceSandboxClient(&workspaceQuotaIntegrationSandbox{}),
	)
	server := setupWorkspaceQuotaIntegrationServer(t, queries, &WorkspaceHandler{Service: service})
	authClient := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, user))

	forkPath := fmt.Sprintf("/api/repos/%s/%s/workspaces/%s/fork", repo.Owner, repo.Name, source.ID)
	resp := routesIntegrationDoRequest(t, authClient, server.URL, http.MethodPost, forkPath, []byte(`{"name":"fork-101"}`))
	require.Equal(t, http.StatusTooManyRequests, resp.StatusCode)

	var body struct {
		Code    pkgerrors.Code `json:"code"`
		Message string         `json:"message"`
	}
	routesIntegrationDecodeJSON(t, resp, &body)
	require.Equal(t, pkgerrors.CodeQuotaExceeded, body.Code)
	require.Contains(t, body.Message, "delete one to continue")

	count, err = queries.CountActiveWorkspacesByUser(context.Background(), user.ID)
	require.NoError(t, err)
	require.Equal(t, int64(100), count)
}

func seedActiveForkWorkspaces(t *testing.T, queries *db.Queries, repositoryID, userID int64, total int) []db.Workspace {
	t.Helper()

	rows := make([]db.Workspace, 0, total)
	for i := 0; i < total; i++ {
		workspace, err := queries.CreateWorkspace(context.Background(), db.CreateWorkspaceParams{
			RepositoryID: repositoryID,
			UserID:       userID,
			Name:         fmt.Sprintf("seed-fork-%03d", i),
			IsFork:       true,
			Status:       "running",
		})
		require.NoError(t, err)
		rows = append(rows, workspace)
	}
	return rows
}

func setupWorkspaceQuotaIntegrationServer(t *testing.T, queries *db.Queries, handler *WorkspaceHandler) *httptest.Server {
	t.Helper()

	r := chi.NewRouter()
	r.Use(middleware.AuthLoader(queries, config.AuthConfig{}))

	r.Route("/api/repos/{owner}/{repo}", func(r chi.Router) {
		r.Use(middleware.LoadRepoContext(queries))
		writeRepo := []func(http.Handler) http.Handler{
			middleware.RequireAuth,
			middleware.RequireScope(middleware.ScopeWriteRepository),
			middleware.RequireRepoPermission(middleware.PermissionWrite),
		}
		r.With(writeRepo...).Post("/workspaces", handler.CreateWorkspace)
		r.With(writeRepo...).Post("/workspaces/{id}/fork", handler.ForkWorkspace)
		r.With(writeRepo...).Delete("/workspaces/{id}", handler.DeleteWorkspace)
	})

	server := httptest.NewServer(r)
	t.Cleanup(server.Close)
	return server
}

type workspaceQuotaIntegrationSandbox struct {
	nextVMID int64
}

func (s *workspaceQuotaIntegrationSandbox) CreateSandbox(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
	id := atomic.AddInt64(&s.nextVMID, 1)
	return sandbox.CreateResult{ID: fmt.Sprintf("quota-vm-%d", id)}, nil
}

func (s *workspaceQuotaIntegrationSandbox) ForkSandbox(context.Context, string, sandbox.ForkRequest) (sandbox.CreateResult, error) {
	id := atomic.AddInt64(&s.nextVMID, 1)
	return sandbox.CreateResult{ID: fmt.Sprintf("quota-fork-vm-%d", id)}, nil
}

func (s *workspaceQuotaIntegrationSandbox) CreateService(context.Context, string, sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
	return sandbox.CreateServiceResult{Success: true}, nil
}

// Execute satisfies the optional exec client the provisioner type-asserts for
// when it clones the repository into the guest. Without it every asynchronous
// creation fails with "sandbox exec client unavailable", the row goes to status
// failed, and it stops counting against the per-user quota under test.
func (s *workspaceQuotaIntegrationSandbox) Execute(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
	ok := int32(0)
	return sandbox.ExecResult{StatusCode: &ok}, nil
}

func (s *workspaceQuotaIntegrationSandbox) InspectSandbox(_ context.Context, vmID string) (sandbox.Sandbox, error) {
	return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
}

func (s *workspaceQuotaIntegrationSandbox) DeleteSandbox(context.Context, string) error {
	return nil
}

func (s *workspaceQuotaIntegrationSandbox) StartSandbox(_ context.Context, vmID string, _ sandbox.StartRequest) (sandbox.StartResult, error) {
	return sandbox.StartResult{ID: vmID}, nil
}

func (s *workspaceQuotaIntegrationSandbox) SuspendSandbox(_ context.Context, vmID string) (sandbox.SuspendResult, error) {
	return sandbox.SuspendResult{ID: vmID}, nil
}

func (s *workspaceQuotaIntegrationSandbox) SnapshotSandbox(_ context.Context, vmID string, _ sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
	return sandbox.SnapshotResult{SnapshotID: "quota-snapshot", SourceSandboxID: vmID}, nil
}

func (s *workspaceQuotaIntegrationSandbox) DeleteSnapshot(context.Context, string) error {
	return nil
}

func (s *workspaceQuotaIntegrationSandbox) CreateIdentity(context.Context) (sandbox.Identity, error) {
	return sandbox.Identity{ID: "quota-identity"}, nil
}

func (s *workspaceQuotaIntegrationSandbox) GrantAccess(context.Context, string, string, sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
	return sandbox.AccessGrant{ID: "quota-permission"}, nil
}

func (s *workspaceQuotaIntegrationSandbox) CreateIdentityToken(context.Context, string) (sandbox.CreatedToken, error) {
	return sandbox.CreatedToken{ID: "quota-token", Token: "quota-token"}, nil
}
