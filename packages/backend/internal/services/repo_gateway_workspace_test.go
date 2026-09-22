package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/deploymentdb"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func boundGatewayFixture(t *testing.T) (*RepoGatewayService, *fakeRepoGatewayQuerier, *fakeRepoGatewayVMClient, *db.Workspace) {
	t.Helper()
	workspace := &db.Workspace{ID: uuid.NewString(), RepositoryID: 101, UserID: 1, VmID: "owned-vm", Status: "running"}
	wq := &mockWorkspaceQuerier{getWorkspaceByRepoFn: func(_ context.Context, p db.GetWorkspaceByRepoParams) (db.Workspace, error) {
		if p.ID != workspace.ID || p.RepositoryID != workspace.RepositoryID || workspace.DeletedAt.Valid {
			return db.Workspace{}, pgx.ErrNoRows
		}
		return *workspace, nil
	}}
	ws := newWorkspaceServiceForTests(wq, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	q := &fakeRepoGatewayQuerier{nextGatewayID: uuid.NewString()}
	vm := &fakeRepoGatewayVMClient{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hash := sha256.Sum256([]byte(defaultWorkspaceClonePath))
		_ = json.NewEncoder(w).Encode(map[string]any{"gatewayId": q.nextGatewayID, "workspaceHash": hex.EncodeToString(hash[:])[:16], "protocolVersion": "1", "version": "1.0.0-rc.0", "capabilities": []string{"coding-plan/v1"}})
	}))
	t.Cleanup(server.Close)
	return newTestRepoGatewayService(q, vm, WithRepoGatewayHealthProbe(server.URL, server.Client()), WithRepoGatewayWorkspaces(ws), WithRepoGatewaySecretCodec(&staticTestCodec{prefix: "enc:"})), q, vm, workspace
}

func TestWorkspaceGateway_UsesOwnedVMAndModernService(t *testing.T) {
	s, q, vm, w := boundGatewayFixture(t)
	input := RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID}
	info, err := s.GetRepoGatewayConnectionInfo(context.Background(), input)
	require.NoError(t, err)
	require.Equal(t, w.ID, info.WorkspaceID)
	require.Equal(t, w.VmID, info.VMID)
	require.Empty(t, vm.createVMReqs)
	require.Empty(t, vm.deletedVMIDs)
	require.Len(t, vm.systemdSpecs, 1)
	spec := vm.systemdSpecs[0]
	assert.Equal(t, defaultWorkspaceUser, spec.User)
	assert.Equal(t, defaultWorkspaceClonePath, spec.Workdir)
	assert.Equal(t, defaultWorkspaceHome, spec.Env["HOME"])
	// The worker prefixes Exec with `exec ` and joins it with spaces, so the
	// launch script must be one /bin/sh -c line (guest log otherwise reads
	// "exec: set: not found" and the gateway never answers its health probe).
	require.Len(t, spec.Exec, 1)
	assert.True(t, strings.HasPrefix(spec.Exec[0], "/bin/sh -c '"), spec.Exec[0])
	assert.Contains(t, spec.Exec[0], "serve --root /home/developer/workspace")
	assert.Contains(t, spec.Exec[0], "--listen")
	assert.NotContains(t, spec.Exec[0], info.Token)
	assert.NotContains(t, spec.Exec[0], "bun x")
	assert.Equal(t, "smithers-gateway-"+info.GatewayID, spec.Name)
	assert.Equal(t, []string{repoGatewayDomain(info.GatewayID)}, vm.mappedDomains)
	require.Len(t, vm.execAwaitReqs, 1)
	assert.NotContains(t, vm.execAwaitReqs[0].Command, "clone")
	assert.NotContains(t, vm.execAwaitReqs[0].Command, "rm -rf")
	assert.Contains(t, vm.execAwaitReqs[0].Command, w.ID)
	assert.True(t, q.created[0].WorkspaceID.Valid)
	assert.Equal(t, "running", q.statusUpdates[len(q.statusUpdates)-1].Status)
}

func TestWorkspaceGateway_RefusesMissingRuntimeWithoutDeletingWorkspace(t *testing.T) {
	s, q, vm, w := boundGatewayFixture(t)
	one := int32(1)
	vm.execAwaitFn = func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{StatusCode: &one}, nil
	}
	_, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
	require.NotEqual(t, pkgerrors.CodeRepositoryWorkspacePending, assertAPIErrorStatus(t, err, http.StatusConflict).Code)
	assert.Empty(t, vm.systemdSpecs)
	assert.Empty(t, vm.createVMReqs)
	assert.Empty(t, vm.deletedVMIDs)
	assert.Empty(t, vm.mappedDomains)
	require.Len(t, q.executionInfo, 1)
	assert.Equal(t, "starting", q.executionInfo[0].Status, "existing row supports retry after runtime correction")
}

func TestWorkspaceGateway_PrimaryProbeReturnsTypedPendingWithoutIdentity(t *testing.T) {
	s, _, vm, w := boundGatewayFixture(t)
	s.provisionResponseBudget = 20 * time.Millisecond
	release, finished := make(chan struct{}), make(chan struct{})
	vm.execAwaitFn = func(ctx context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
		defer close(finished)
		select {
		case <-release:
		case <-ctx.Done():
		}
		one := int32(1)
		return sandbox.ExecResult{StatusCode: &one}, nil
	}
	t.Cleanup(func() {
		close(release)
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Error("detached preflight did not finish")
		}
	})
	compatible, err := s.ProbeWorkspaceCapability(context.Background(), *w, repositoryJobsCapability)
	require.False(t, compatible)
	api := assertAPIErrorStatus(t, err, http.StatusConflict)
	require.Equal(t, pkgerrors.CodeRepositoryWorkspacePending, api.Code)
	require.Nil(t, api.Details, "pending observation does not confer a workspace selection")
}

func TestWorkspaceGateway_MissingVMPendingOnlyWhenProvisioning(t *testing.T) {
	for _, status := range []string{"pending", "starting", "running"} {
		t.Run(status, func(t *testing.T) {
			s, _, vm, w := boundGatewayFixture(t)
			w.VmID = ""
			w.Status = status
			info, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
			api := assertAPIErrorStatus(t, err, http.StatusConflict)
			require.Empty(t, info.WorkspaceID)
			require.Empty(t, vm.createVMReqs)
			if status == "running" {
				require.NotEqual(t, pkgerrors.CodeRepositoryWorkspacePending, api.Code)
			} else {
				require.Equal(t, pkgerrors.CodeRepositoryWorkspacePending, api.Code)
			}
		})
	}
}

func TestWorkspaceGateway_RechecksLifecycleDuringProvision(t *testing.T) {
	for _, mode := range []string{"deleted", "vm-replaced", "suspended"} {
		t.Run(mode, func(t *testing.T) {
			s, _, vm, w := boundGatewayFixture(t)
			vm.createSystemdServiceFn = func(context.Context, string, sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
				switch mode {
				case "deleted":
					w.DeletedAt.Valid = true
				case "vm-replaced":
					w.VmID = "replacement-vm"
				case "suspended":
					w.Status = "suspended"
				}
				return sandbox.CreateServiceResult{Success: true}, nil
			}
			_, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
			require.Error(t, err)
			assert.Empty(t, vm.deletedVMIDs)
			assert.Empty(t, vm.mappedDomains)
			require.Len(t, vm.execAwaitReqs, 2)
			assert.Contains(t, vm.execAwaitReqs[1].Command, "systemctl disable --now")
		})
	}
}

func TestWorkspaceGateway_ReaperNeverDeletesUserVM(t *testing.T) {
	for _, status := range []string{"pending", "starting", "running", "failed"} {
		t.Run(status, func(t *testing.T) {
			s, q, vm, w := boundGatewayFixture(t)
			g := clusterdb.RepoGateway{ID: uuid.NewString(), WorkspaceID: pgtype.UUID{Bytes: uuid.MustParse(w.ID), Valid: true}, VmID: w.VmID, Status: status, RepositoryID: w.RepositoryID, UserID: w.UserID}
			if status == "running" {
				s.discardGateway(context.Background(), g)
			} else {
				q.staleRows = []clusterdb.RepoGateway{g}
				s.sweepStaleGateways(context.Background())
			}
			assert.Empty(t, vm.deletedVMIDs)
			assert.Equal(t, []string{repoGatewayDomain(g.ID)}, vm.unmappedDomains)
			require.Len(t, vm.execAwaitReqs, 1)
			assert.Contains(t, vm.execAwaitReqs[0].Command, workspaceGatewayServiceName(g))
			assert.Equal(t, []string{g.ID}, q.getSoftDeleted())
		})
	}
}

func TestWorkspaceGateway_BindingValidationBeforeSideEffects(t *testing.T) {
	s, q, vm, w := boundGatewayFixture(t)
	for _, input := range []RepoGatewayConnectionInput{
		{WorkspaceID: "nope", RepositoryID: w.RepositoryID, UserID: w.UserID},
		{WorkspaceID: w.ID, RepositoryID: w.RepositoryID + 1, UserID: w.UserID},
		{WorkspaceID: w.ID, RepositoryID: w.RepositoryID, UserID: 999},
	} {
		_, err := s.GetRepoGatewayConnectionInfo(context.Background(), input)
		require.Error(t, err)
	}
	assert.Empty(t, q.created)
	assert.Empty(t, vm.execAwaitReqs)
	assert.Empty(t, vm.createVMReqs)
}

func TestWorkspaceGateway_PostgresBindingLifecycle(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	q := deploymentdb.New(pool)
	userID, repoID := setupTestUserAndRepo(t, pool)
	workspace, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repoID, UserID: userID, Name: "bound-gateway", TargetBookmark: "main", Kind: "vm", Status: "running"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='owned-vm' WHERE id=$1`, workspace.ID)
	require.NoError(t, err)
	binding := pgtype.UUID{Bytes: uuid.MustParse(workspace.ID), Valid: true}
	legacy, err := q.CreateRepoGateway(ctx, clusterdb.CreateRepoGatewayParams{RepositoryID: repoID, UserID: userID, Status: "running"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE repo_gateways SET vm_id='legacy-vm' WHERE id=$1`, legacy.ID)
	require.NoError(t, err)
	bound, err := q.CreateRepoGateway(ctx, clusterdb.CreateRepoGatewayParams{RepositoryID: repoID, UserID: userID, WorkspaceID: binding, Status: "running"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE repo_gateways SET vm_id='owned-vm' WHERE id=$1`, bound.ID)
	require.NoError(t, err)
	landingToken, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{
		UserID: userID, Name: "gateway-landing", TokenHash: "test-landing-" + bound.ID,
		TokenLastEight: "landing1", Scopes: "repo:read",
	})
	require.NoError(t, err)
	require.NoError(t, q.SetRepoGatewayLandingTokenID(ctx, clusterdb.SetRepoGatewayLandingTokenIDParams{
		ID: bound.ID, LandingTokenID: pgtype.Int8{Int64: landingToken.ID, Valid: true},
	}))
	read, err := q.GetActiveRepoGatewayForUserRepo(ctx, clusterdb.GetActiveRepoGatewayForUserRepoParams{RepositoryID: repoID, UserID: userID, WorkspaceID: binding})
	require.NoError(t, err)
	require.Equal(t, bound.ID, read.ID)
	read, err = q.GetActiveRepoGatewayForUserRepo(ctx, clusterdb.GetActiveRepoGatewayForUserRepoParams{RepositoryID: repoID, UserID: userID})
	require.NoError(t, err)
	require.Equal(t, legacy.ID, read.ID)
	byID, err := q.GetRepoGatewayByID(ctx, bound.ID)
	require.NoError(t, err)
	require.Equal(t, binding, byID.WorkspaceID)
	require.Equal(t, landingToken.ID, byID.LandingTokenID.Int64)
	rows, err := q.ListActiveRepoGateways(ctx)
	require.NoError(t, err)
	require.Contains(t, rows, byID)
	// The sweep reads these same generated rows. It must see the credential
	// reference so a discarded gateway can revoke its temporary token.
	s := newTestRepoGatewayService(q, &fakeRepoGatewayVMClient{})
	s.revokeWorkspaceGatewayLandingToken(ctx, byID)
	var tokenCount int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE id=$1`, landingToken.ID).Scan(&tokenCount))
	require.Zero(t, tokenCount)
	byID, err = q.GetRepoGatewayByID(ctx, bound.ID)
	require.NoError(t, err)
	require.False(t, byID.LandingTokenID.Valid)
	count, err := q.CountActiveSandboxesForUser(ctx, userID)
	require.NoError(t, err)
	require.Equal(t, 2, count, "bound process must not count as a third VM")
	_, err = q.CreateRepoGateway(ctx, clusterdb.CreateRepoGatewayParams{RepositoryID: repoID, UserID: userID, WorkspaceID: binding, Status: "running"})
	require.Error(t, err)
	require.True(t, isRepoGatewayActiveUniqueViolation(err))
	// The actual relation rejects unknown workspace IDs, not an inferred VM ID.
	_, err = q.CreateRepoGateway(ctx, clusterdb.CreateRepoGatewayParams{RepositoryID: repoID, UserID: userID, WorkspaceID: pgtype.UUID{Bytes: uuid.New(), Valid: true}, Status: "pending"})
	require.Error(t, err)
	ws := NewWorkspaceService(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	s = newTestRepoGatewayService(q, &fakeRepoGatewayVMClient{}, WithRepoGatewayWorkspaces(ws))
	token, hash, _ := generateRepoGatewayToken()
	_, err = pool.Exec(ctx, `UPDATE repo_gateways SET auth_token_hash=$1 WHERE id=$2`, hash, bound.ID)
	require.NoError(t, err)
	target, err := s.AuthorizeRelay(ctx, bound.ID, token)
	require.NoError(t, err)
	require.Equal(t, workspace.ID, target.WorkspaceID)
	require.Equal(t, repoGatewayDomain(bound.ID), target.Domain)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='replacement-vm' WHERE id=$1`, workspace.ID)
	require.NoError(t, err)
	_, err = s.AuthorizeRelay(ctx, bound.ID, token)
	assertAPIErrorStatus(t, err, http.StatusConflict)
	_, err = q.SoftDeleteWorkspace(ctx, workspace.ID)
	require.NoError(t, err)
	_, err = s.AuthorizeRelay(ctx, bound.ID, token)
	assertAPIErrorStatus(t, err, http.StatusNotFound)
	_, err = pool.Exec(ctx, `DELETE FROM workspaces WHERE id=$1`, workspace.ID)
	require.NoError(t, err)
	_, err = q.GetRepoGatewayByID(ctx, bound.ID)
	require.True(t, errors.Is(err, pgx.ErrNoRows))
	_, err = q.GetRepoGatewayByID(ctx, legacy.ID)
	require.NoError(t, err)
	assert.False(t, strings.Contains(target.Domain, "owned-vm"))
}

func TestWorkspaceGateway_ReadinessRequiresRegisteredCodingHost(t *testing.T) {
	for _, capabilities := range []bool{false, true} {
		t.Run(fmt.Sprint(capabilities), func(t *testing.T) {
			s, q, vm, w := boundGatewayFixture(t)
			server := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
				hash := sha256.Sum256([]byte(defaultWorkspaceClonePath))
				health := map[string]any{"gatewayId": q.nextGatewayID, "workspaceHash": hex.EncodeToString(hash[:])[:16], "protocolVersion": "1", "version": "1.0.0-rc.0"}
				if capabilities {
					health["capabilities"] = []string{"coding-plan/v1"}
				}
				_ = json.NewEncoder(rw).Encode(health)
			}))
			defer server.Close()
			s.healthProbeBaseURL = server.URL
			s.healthProbeClient = server.Client()
			_, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
			if capabilities {
				require.NoError(t, err)
			} else {
				assertAPIErrorStatus(t, err, http.StatusConflict)
				require.Contains(t, err.Error(), "coding-plan/v1")
			}
			assert.Empty(t, vm.deletedVMIDs)
		})
	}
}

// A deployment with no health probe configured refuses every bound gateway,
// for every account, until an operator sets the variable. It used to answer
// coding_host_unavailable — a 409 that told the caller their box needed a
// newer runtime, about a box that was never looked at.
func TestWorkspaceGateway_UnconfiguredProbeBlamesTheDeployment(t *testing.T) {
	s, _, vm, w := boundGatewayFixture(t)
	s.healthProbeBaseURL = ""
	_, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
	apiErr := assertAPIErrorStatus(t, err, http.StatusServiceUnavailable)
	assert.Equal(t, pkgerrors.CodeCodingGatewayNotConfigured, apiErr.Code)
	assert.NotContains(t, err.Error(), "provisioned runtime",
		"the box was never inspected; do not tell the caller to update it")
	assert.Empty(t, vm.deletedVMIDs)
}

// Exercise the real conditional status write at the last readiness boundary,
// where a reaper can win after the service's last identity read.
type tombstoneGatewayAtReadiness struct {
	*deploymentdb.Queries
	beforeRunning func()
}

func (q *tombstoneGatewayAtReadiness) UpdateRepoGatewayStatus(ctx context.Context, p clusterdb.UpdateRepoGatewayStatusParams) (clusterdb.RepoGateway, error) {
	if p.Status == "running" && q.beforeRunning != nil {
		q.beforeRunning()
	}
	return q.Queries.UpdateRepoGatewayStatus(ctx, p)
}

func TestWorkspaceGateway_PostgresReaperFencesReadiness(t *testing.T) {
	prepareRuntimeTestHelper(t)
	pool := getAgentTestPool(t)
	ctx := context.Background()
	q := &tombstoneGatewayAtReadiness{Queries: deploymentdb.New(pool)}
	userID, repoID := setupTestUserAndRepo(t, pool)
	workspace, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repoID, UserID: userID, Name: "gateway-readiness-race", TargetBookmark: "main", Kind: "vm", Status: "running"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='owned-vm' WHERE id=$1`, workspace.ID)
	require.NoError(t, err)
	binding := pgtype.UUID{Bytes: uuid.MustParse(workspace.ID), Valid: true}
	gateway, err := q.CreateRepoGateway(ctx, clusterdb.CreateRepoGatewayParams{RepositoryID: repoID, UserID: userID, WorkspaceID: binding, Status: "starting"})
	require.NoError(t, err)
	codec := &staticTestCodec{prefix: "enc:"}
	token, hash, err := generateRepoGatewayToken()
	require.NoError(t, err)
	ciphertext, err := codec.EncryptString(token)
	require.NoError(t, err)
	gateway, err = q.UpdateRepoGatewayExecutionInfo(ctx, clusterdb.UpdateRepoGatewayExecutionInfoParams{ID: gateway.ID, VmID: "owned-vm", BaseUrl: "https://" + repoGatewayDomain(gateway.ID), AuthTokenHash: hash, AuthTokenCiphertext: ciphertext, Status: "starting"})
	require.NoError(t, err)
	vm := &fakeRepoGatewayVMClient{}
	vm.execAwaitFn = func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		zero := int32(0)
		if req.TimeoutMS != nil && *req.TimeoutMS == 15000 {
			return sandbox.ExecResult{StatusCode: &zero, Stdout: runtimeTestReceipt(t, workspace, "unchanged")}, nil
		}
		return sandbox.ExecResult{StatusCode: &zero}, nil
	}
	workspaceVM := &mockWorkspaceSandboxVMClient{execAwaitFn: func(_ context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
		zero := int32(0)
		return sandbox.ExecResult{StatusCode: &zero, Stdout: runtimeTestReceipt(t, workspace, "unchanged")}, nil
	}}
	ws := NewWorkspaceService(q, WithWorkspaceSandboxClient(workspaceVM))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		root := sha256.Sum256([]byte(defaultWorkspaceClonePath))
		_ = json.NewEncoder(w).Encode(map[string]any{"gatewayId": gateway.ID, "workspaceHash": hex.EncodeToString(root[:])[:16], "protocolVersion": "1", "version": "1.0.0-rc.0", "capabilities": []string{"coding-plan/v1"}})
	}))
	defer server.Close()
	s := newTestRepoGatewayService(q, vm, WithRepoGatewayWorkspaces(ws), WithRepoGatewaySecretCodec(codec), WithRepoGatewayHealthProbe(server.URL, server.Client()))
	q.beforeRunning = func() { s.discardGateway(ctx, gateway) }
	_, err = s.reuseWorkspaceGateway(ctx, gateway)
	assertAPIErrorStatus(t, err, http.StatusConflict)
	var status string
	var deleted bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT status, deleted_at IS NOT NULL FROM repo_gateways WHERE id=$1`, gateway.ID).Scan(&status, &deleted))
	assert.Equal(t, "stopped", status)
	assert.True(t, deleted)
	assert.Empty(t, vm.deletedVMIDs)
	require.Len(t, vm.systemdSpecs, 1)
	assert.Equal(t, []string{repoGatewayDomain(gateway.ID), repoGatewayDomain(gateway.ID)}, vm.unmappedDomains)
	for _, request := range vm.execAwaitReqs[1:] {
		assert.Contains(t, request.Command, workspaceGatewayServiceName(gateway))
	}
	retained, err := q.GetWorkspaceByRepo(ctx, db.GetWorkspaceByRepoParams{ID: workspace.ID, RepositoryID: repoID})
	require.NoError(t, err)
	assert.Equal(t, "owned-vm", retained.VmID)
}

func TestWorkspaceGateway_ReplacementSharesProcessLockButNotCleanupIdentity(t *testing.T) {
	_, _, _, workspace := boundGatewayFixture(t)
	old := clusterdb.RepoGateway{ID: uuid.NewString(), WorkspaceID: pgtype.UUID{Bytes: uuid.MustParse(workspace.ID), Valid: true}}
	replacement := old
	replacement.ID = uuid.NewString()
	assert.Equal(t, workspaceGatewayLockPath(old), workspaceGatewayLockPath(replacement))
	assert.NotEqual(t, workspaceGatewayServiceName(old), workspaceGatewayServiceName(replacement))
	assert.NotEqual(t, gatewayIngressDomain(old), gatewayIngressDomain(replacement))
	command := workspaceGatewayCommand(replacement)
	assert.Contains(t, command, "flock --nonblock --no-fork --conflict-exit-code 75")
	assert.Contains(t, command, workspace.ID)
	assert.NotContains(t, command, replacement.ID)
	preflight := workspaceGatewayPreflight(replacement)
	assert.Contains(t, preflight, "PATH=/usr/local/bin:/run/current-system/sw/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	assert.Contains(t, preflight, "touch '"+workspaceGatewayLockPath(old)+"'")
	assert.Contains(t, preflight, "chown root:root")
	assert.NotContains(t, preflight, "rm ")
}

func TestWorkspaceGateway_RefusesMissingModelBeforeStartingService(t *testing.T) {
	s, _, vm, w := boundGatewayFixture(t)
	missing := int32(43)
	vm.execAwaitFn = func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{StatusCode: &missing}, nil
	}
	_, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "SMITHERS_CODING_IMPLEMENT_MODEL")
	apiErr := assertAPIErrorStatus(t, err, http.StatusConflict)
	assert.Equal(t, pkgerrors.CodeCodingProviderRefreshRequired, apiErr.Code)
	assert.Empty(t, vm.systemdSpecs)
	assert.Empty(t, vm.mappedDomains)
	assert.Empty(t, vm.deletedVMIDs)
}

func TestWorkspaceGateway_ProviderBootstrapPreservesHealthyHost(t *testing.T) {
	s, q, vm, w := boundGatewayFixture(t)
	input := RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID}
	first, err := s.GetRepoGatewayConnectionInfo(context.Background(), input)
	require.NoError(t, err)
	// This capture-only fixture does not persist writes automatically.
	q.active = &clusterdb.RepoGateway{ID: first.GatewayID, RepositoryID: w.RepositoryID, UserID: w.UserID,
		WorkspaceID: pgtype.UUID{Bytes: uuid.MustParse(w.ID), Valid: true}, VmID: w.VmID,
		AuthTokenCiphertext: "enc:" + first.Token, Status: "running"}
	WithWorkspaceProviderBootstrap(map[string]string{"OPENAI_API_KEY": "platform-private"}, "openai:gpt-5.6-luna")(s.workspaces)
	s.workspaces.sandbox = &mockWorkspaceSandboxVMClient{
		startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
			t.Error("a healthy host must not replace its live egress proxy")
			return sandbox.StartResult{}, errors.New("unexpected proxy replacement")
		},
	}
	vm.execAwaitFn = func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		t.Error("a healthy host must not rerun provider or runtime preflight")
		return sandbox.ExecResult{}, errors.New("unexpected preflight")
	}
	serviceCount := len(vm.systemdSpecs)
	second, err := s.GetRepoGatewayConnectionInfo(context.Background(), input)
	require.NoError(t, err)
	require.Equal(t, first.GatewayID, second.GatewayID)
	require.Len(t, vm.systemdSpecs, serviceCount, "a running service and its outstanding runs remain alive")
	require.Empty(t, vm.startedVMIDs)
	require.Empty(t, vm.deletedVMIDs)
}

func TestWorkspaceGateway_RequiredCapabilityPreservesOlderLiveHost(t *testing.T) {
	s, q, vm, w := boundGatewayFixture(t)
	input := RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID}
	first, err := s.GetRepoGatewayConnectionInfo(context.Background(), input)
	require.NoError(t, err)
	q.active = &clusterdb.RepoGateway{ID: first.GatewayID, RepositoryID: w.RepositoryID, UserID: w.UserID,
		WorkspaceID: pgtype.UUID{Bytes: uuid.MustParse(w.ID), Valid: true}, VmID: w.VmID,
		AuthTokenCiphertext: "enc:" + first.Token, Status: "running"}
	vm.execAwaitReqs, vm.systemdSpecs = nil, nil
	input.RequiredCapability = repositoryJobsCapability
	_, err = s.GetRepoGatewayConnectionInfo(context.Background(), input)
	apiError := assertAPIErrorStatus(t, err, http.StatusConflict)
	require.Equal(t, pkgerrors.CodeCodingHostUpgradeRequired, apiError.Code)
	require.Equal(t, w.ID, apiError.Details.(map[string]string)["workspace_id"])
	require.Empty(t, vm.execAwaitReqs, "no read-then-restart race may stop an older host")
	require.Empty(t, vm.systemdSpecs)
	require.Empty(t, vm.deletedVMIDs)
	compatible, err := s.ProbeWorkspaceCapability(context.Background(), *w, repositoryJobsCapability)
	require.NoError(t, err)
	require.False(t, compatible, "a healthy older host is an unsuitable primary, not permission to restart it")
	require.Empty(t, vm.execAwaitReqs)
	require.Empty(t, vm.systemdSpecs)
	input.RequiredCapability = ""
	_, err = s.GetRepoGatewayConnectionInfo(context.Background(), input)
	require.NoError(t, err, "existing ordinary operations keep their old host")
	capabilities := make(chan []string, 4)
	for range 2 {
		capabilities <- []string{"coding-plan/v1", repositoryJobsCapability}
	}
	for range 2 {
		capabilities <- []string{"coding-plan/v1", repositoryJobsCapability, "repository-source/v1"}
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		hash := sha256.Sum256([]byte(defaultWorkspaceClonePath))
		_ = json.NewEncoder(response).Encode(map[string]any{"gatewayId": first.GatewayID, "workspaceHash": hex.EncodeToString(hash[:])[:16], "protocolVersion": "1", "version": "1.0.0", "capabilities": <-capabilities})
	}))
	defer server.Close()
	s.healthProbeBaseURL, s.healthProbeClient = server.URL, server.Client()
	input.RequiredCapability = repositoryJobsCapability
	_, err = s.GetRepoGatewayConnectionInfo(context.Background(), input)
	require.Equal(t, pkgerrors.CodeCodingHostUpgradeRequired, assertAPIErrorStatus(t, err, http.StatusConflict).Code, "baseline repository-jobs alone cannot capture fork sources")
	ready, err := s.GetRepoGatewayConnectionInfo(context.Background(), input)
	require.NoError(t, err)
	require.Equal(t, first.GatewayID, ready.GatewayID)
	require.Empty(t, vm.systemdSpecs)
}

func TestWorkspaceGateway_PrimaryCapabilityStartsHostWithoutAllocating(t *testing.T) {
	s, q, vm, w := boundGatewayFixture(t)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		hash := sha256.Sum256([]byte(defaultWorkspaceClonePath))
		_ = json.NewEncoder(response).Encode(map[string]any{"gatewayId": q.nextGatewayID, "workspaceHash": hex.EncodeToString(hash[:])[:16], "protocolVersion": "1", "version": "1.0.0", "capabilities": []string{"coding-plan/v1", repositoryJobsCapability, "repository-source/v1"}})
	}))
	defer server.Close()
	s.healthProbeBaseURL, s.healthProbeClient = server.URL, server.Client()
	compatible, err := s.ProbeWorkspaceCapability(context.Background(), *w, repositoryJobsCapability)
	require.NoError(t, err)
	require.True(t, compatible)
	require.Len(t, vm.systemdSpecs, 1, "fresh imported workspace starts its already staged host")
	require.Empty(t, vm.createVMReqs)
	require.Empty(t, vm.deletedVMIDs)
	stale := *w
	stale.VmID = "previous-vm"
	_, err = s.ProbeWorkspaceCapability(context.Background(), stale, repositoryJobsCapability)
	require.ErrorContains(t, err, "workspace changed during capability check")
}
