package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/microsandbox/control"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type manageFake struct {
	AdminManageQuerier
	session         db.AgentSession
	workspace       db.Workspace
	err             error
	auditErr        error
	auditFailFrom   int
	auditCalls      int
	beforeAction    func()
	audits          []db.InsertAuditLogParams
	owner, repo     int64
	action          string
	hours           int32
	agentParams     db.AdminListAgentSessionsParams
	workspaceParams db.AdminListWorkspacesParams
	tokenParams     db.AdminListTokensParams
}

func (f *manageFake) GetAgentSession(context.Context, string) (db.AgentSession, error) {
	return f.session, f.err
}
func (f *manageFake) GetWorkspace(context.Context, string) (db.Workspace, error) {
	return f.workspace, f.err
}
func (f *manageFake) InsertAuditLog(_ context.Context, p db.InsertAuditLogParams) error {
	f.auditCalls++
	if f.auditErr != nil && (f.auditFailFrom == 0 || f.auditCalls >= f.auditFailFrom) {
		return f.auditErr
	}
	f.audits = append(f.audits, p)
	return nil
}
func (f *manageFake) CancelSession(_ context.Context, _ string, owner int64, reason string) error {
	f.owner = owner
	if f.beforeAction != nil {
		f.beforeAction()
	}
	f.action = "cancel:" + reason
	return f.err
}
func (f *manageFake) StopWorkspace(_ context.Context, _ string, repo, owner int64) (WorkspaceResponse, error) {
	f.owner = owner
	f.repo = repo
	f.action = "stop"
	if f.beforeAction != nil {
		f.beforeAction()
	}
	return WorkspaceResponse{Status: "stopped"}, f.err
}
func (f *manageFake) SuspendWorkspace(_ context.Context, _ string, repo, owner int64) (WorkspaceResponse, error) {
	f.owner = owner
	f.repo = repo
	if f.beforeAction != nil {
		f.beforeAction()
	}
	f.action = "suspend"
	return WorkspaceResponse{Status: "suspended"}, f.err
}
func (f *manageFake) DrainHost(context.Context, string) error {
	if f.beforeAction != nil {
		f.beforeAction()
	}
	f.action = "drain"
	return f.err
}
func (f *manageFake) AdminPruneStaleSandboxHosts(ctx context.Context, p db.AdminPruneStaleSandboxHostsParams) (int64, error) {
	if f.err != nil {
		return 0, f.err
	}
	if err := f.InsertAuditLog(ctx, db.InsertAuditLogParams{EventType: "admin.sandbox_host.prune", ActorID: p.ActorID}); err != nil {
		return 0, err
	}
	f.hours = p.OlderThanHours
	return 2, nil
}
func (f *manageFake) AdminListAgentSessions(_ context.Context, p db.AdminListAgentSessionsParams) ([]db.AdminListAgentSessionsRow, error) {
	f.agentParams = p
	return []db.AdminListAgentSessionsRow{{AgentSession: f.session, Username: "owner", Repository: "org/repo"}}, f.err
}
func (f *manageFake) AdminListWorkspaces(_ context.Context, p db.AdminListWorkspacesParams) ([]db.AdminListWorkspacesRow, error) {
	f.workspaceParams = p
	return []db.AdminListWorkspacesRow{{Workspace: f.workspace, Owner: "owner", Repository: "org/repo"}}, f.err
}
func (f *manageFake) AdminListSandboxHosts(context.Context) ([]db.AdminListSandboxHostsRow, error) {
	return []db.AdminListSandboxHostsRow{{SandboxHost: db.SandboxHost{ID: "worker", CapacityMemoryBytes: 1 << 54, AllocatedVms: 3, ObservedAllocatedVms: 2}}}, f.err
}
func (f *manageFake) AdminListTokens(_ context.Context, p db.AdminListTokensParams) ([]db.AdminListTokensRow, error) {
	f.tokenParams = p
	return []db.AdminListTokensRow{{ID: 1 << 54, Name: "token", Username: "owner", Scopes: "read:admin"}}, f.err
}
func manageTestContext() context.Context {
	return ContextWithAdminAuditActor(context.Background(), AdminAuditActor{UserID: 99, Username: "admin", IPAddress: "127.0.0.1"})
}
func TestAdminManageMutations(t *testing.T) {
	for _, action := range []string{"cancel", "stop", "suspend", "drain", "prune"} {
		t.Run(action, func(t *testing.T) {
			f := &manageFake{session: db.AgentSession{Status: "active", UserID: 7}, workspace: db.Workspace{Status: "running", UserID: 8, RepositoryID: 4}}
			s := NewAdminManageService(f, f, f, f)
			ctx := manageTestContext()
			var err error
			event := ""
			switch action {
			case "cancel":
				var r AdminManageStatus
				r, err = s.CancelAgentSession(ctx, "id", "operator reason")
				require.Equal(t, "cancelled", r.Status)
				require.EqualValues(t, 7, f.owner)
				require.Equal(t, "cancel:operator reason", f.action)
				event = "admin.agent_session.cancel"
			case "stop":
				var r AdminManageStatus
				r, err = s.StopWorkspace(ctx, "id")
				require.Equal(t, "stopped", r.Status)
				event = "admin.workspace.stop"
			case "suspend":
				var r AdminManageStatus
				r, err = s.SuspendWorkspace(ctx, "id")
				require.Equal(t, "suspended", r.Status)
				event = "admin.workspace.suspend"
			case "drain":
				var r AdminHostState
				r, err = s.DrainSandboxHost(ctx, "id")
				require.Equal(t, "draining", r.State)
				event = "admin.sandbox_host.drain"
			case "prune":
				var r AdminPruneResult
				r, err = s.PruneStaleSandboxHosts(ctx, 0)
				require.EqualValues(t, 2, r.Pruned)
				require.EqualValues(t, 24, f.hours)
				event = "admin.sandbox_host.prune"
			}
			require.NoError(t, err)
			if action == "prune" {
				require.Len(t, f.audits, 1)
			} else {
				require.Len(t, f.audits, 2)
			}
			require.Equal(t, event, f.audits[0].EventType)
			require.EqualValues(t, 99, f.audits[0].ActorID.Int64)
			if action == "stop" || action == "suspend" {
				require.EqualValues(t, 8, f.owner)
				require.EqualValues(t, 4, f.repo)
			}
		})
	}
}
func TestAdminManageRejectsInvalidTransitionsAndFailures(t *testing.T) {
	f := &manageFake{session: db.AgentSession{Status: "completed"}, workspace: db.Workspace{Status: "stopped"}}
	s := NewAdminManageService(f, f, f, f)
	ctx := manageTestContext()
	check := func(err error, status int) {
		t.Helper()
		var api *pkgerrors.APIError
		require.ErrorAs(t, err, &api)
		require.Equal(t, status, api.Status)
	}
	_, err := s.CancelAgentSession(ctx, "id", "")
	check(err, 409)
	_, err = s.StopWorkspace(ctx, "id")
	check(err, 409)
	_, err = s.SuspendWorkspace(ctx, "id")
	check(err, 409)
	_, err = s.PruneStaleSandboxHosts(ctx, -1)
	check(err, 400)
	_, err = s.DrainSandboxHost(context.Background(), "id")
	check(err, 401)
	require.Empty(t, f.audits)
	require.Empty(t, f.action)
	f.err = pgx.ErrNoRows
	_, err = s.CancelAgentSession(ctx, "id", "")
	check(err, 404)
	_, err = s.StopWorkspace(ctx, "id")
	check(err, 404)
	f.err = control.ErrHostNotDrainable
	_, err = s.DrainSandboxHost(ctx, "id")
	check(err, 409)
	f.err = control.ErrNotFound
	_, err = s.DrainSandboxHost(ctx, "id")
	check(err, 404)
	f.err = errors.New("database unavailable")
	_, err = s.PruneStaleSandboxHosts(ctx, 24)
	check(err, 500)
	f.err = nil
	f.auditErr = errors.New("audit unavailable")
	_, err = s.DrainSandboxHost(ctx, "id")
	check(err, 500)
}
func TestAdminManageLists(t *testing.T) {
	now := time.Now().UTC()
	f := &manageFake{session: db.AgentSession{ID: "session", Status: "active", CreatedAt: now.Add(-2 * time.Hour), WorkflowRunID: pgtype.Int8{Int64: 1 << 54, Valid: true}}, workspace: db.Workspace{ID: "workspace", Status: "failed", FailureCode: pgtype.Text{String: "boot_failed", Valid: true}}}
	s := NewAdminManageService(f, f, f, f)
	ctx := context.Background()
	agents, err := s.ListAgentSessions(ctx, db.AdminListAgentSessionsParams{})
	require.NoError(t, err)
	require.Equal(t, "active", f.agentParams.Status)
	require.EqualValues(t, 100, f.agentParams.RowLimit)
	require.False(t, f.agentParams.IncludeSynthetic)
	require.Equal(t, "org/repo", agents[0].Repository)
	require.Equal(t, "18014398509481984", *agents[0].WorkflowRunID)
	require.Nil(t, agents[0].StartedAt)
	require.GreaterOrEqual(t, agents[0].AgeSeconds, int64(7200))
	workspaces, err := s.ListWorkspaces(ctx, db.AdminListWorkspacesParams{Kind: "agent", Status: "failed", Owner: "Owner", IncludeSynthetic: true, RowLimit: 200})
	require.NoError(t, err)
	require.Equal(t, "boot_failed", *workspaces[0].FailureCode)
	require.True(t, f.workspaceParams.IncludeSynthetic)
	hosts, err := s.ListSandboxHosts(ctx)
	require.NoError(t, err)
	require.Equal(t, "worker", hosts[0].WorkerID)
	require.EqualValues(t, 3, hosts[0].Allocated.VMs)
	require.EqualValues(t, 2, hosts[0].Observed.VMs)
	b, err := json.Marshal(hosts)
	require.NoError(t, err)
	require.Contains(t, string(b), `"memory_bytes":"18014398509481984"`)
	tokens, err := s.ListTokens(ctx, db.AdminListTokensParams{UnusedDays: 30, ExpiringDays: 7, Scope: "read:admin", RowLimit: 500})
	require.NoError(t, err)
	require.EqualValues(t, 30, f.tokenParams.UnusedDays)
	b, err = json.Marshal(tokens)
	require.NoError(t, err)
	require.Contains(t, string(b), `"id":"18014398509481984"`)
	require.NotContains(t, string(b), "hash")
	_, err = s.ListAgentSessions(ctx, db.AdminListAgentSessionsParams{Status: "failed"})
	require.Error(t, err)
	_, err = s.ListAgentSessions(ctx, db.AdminListAgentSessionsParams{RowLimit: 201})
	require.Error(t, err)
	_, err = s.ListWorkspaces(ctx, db.AdminListWorkspacesParams{Kind: "bogus"})
	require.Error(t, err)
	_, err = s.ListWorkspaces(ctx, db.AdminListWorkspacesParams{Status: "bogus"})
	require.Error(t, err)
	_, err = s.ListTokens(ctx, db.AdminListTokensParams{UnusedDays: -1})
	require.Error(t, err)
	f.err = errors.New("db failure")
	_, err = s.ListAgentSessions(ctx, db.AdminListAgentSessionsParams{})
	require.Error(t, err)
	_, err = s.ListWorkspaces(ctx, db.AdminListWorkspacesParams{})
	require.Error(t, err)
	_, err = s.ListSandboxHosts(ctx)
	require.Error(t, err)
	_, err = s.ListTokens(ctx, db.AdminListTokensParams{})
	require.Error(t, err)
}

type neverStartedFake struct {
	*mockAgentDispatchQuerier
	rows                 []db.AgentSession
	listErr, errorUpdate error
	cutoff               time.Time
	updates              int
}

func (f *neverStartedFake) ListNeverStartedAgentSessions(_ context.Context, c time.Time) ([]db.AgentSession, error) {
	f.cutoff = c
	return f.rows, f.listErr
}
func (f *neverStartedFake) FailNeverStartedAgentSession(_ context.Context, p db.FailNeverStartedAgentSessionParams) (db.AgentSession, error) {
	f.updates++
	if f.errorUpdate != nil {
		return db.AgentSession{}, f.errorUpdate
	}
	return db.AgentSession{ID: p.ID, Status: "failed", Metadata: []byte(`{"failure_reason":"never_started"}`)}, nil
}
func TestAgentReaperNeverStarted(t *testing.T) {
	for _, timeout := range []time.Duration{0, 2 * time.Hour} {
		t.Run(timeout.String(), func(t *testing.T) {
			f := &neverStartedFake{mockAgentDispatchQuerier: &mockAgentDispatchQuerier{}, rows: []db.AgentSession{{ID: "never-started"}}}
			metrics := &mockAgentSessionMetricsObserver{}
			s := &AgentService{dispatchQ: f, sessionMetrics: metrics, neverStartedTimeout: timeout}
			require.NoError(t, s.reapExpiredSessions(context.Background(), 24*time.Hour))
			expected := timeout
			if expected == 0 {
				expected = time.Hour
			}
			require.WithinDuration(t, time.Now().Add(-expected), f.cutoff, time.Second)
			require.Equal(t, []string{"failed"}, metrics.completions)
			require.Zero(t, metrics.timeouts)
			f.errorUpdate = pgx.ErrNoRows
			require.NoError(t, s.reapNeverStartedSessions(context.Background()))
			require.Len(t, metrics.completions, 1)
			f.errorUpdate = errors.New("update failed")
			require.Error(t, s.reapNeverStartedSessions(context.Background()))
			require.Len(t, metrics.completions, 1)
			f.listErr = errors.New("list failed")
			require.Error(t, s.reapNeverStartedSessions(context.Background()))
		})
	}
}
func TestAgentCancelUsesTerminalCleanup(t *testing.T) {
	row := db.AgentSession{ID: "session", UserID: 7, Status: "active", WorkflowRunID: pgtype.Int8{Int64: 12, Valid: true}}
	deleted := false
	revoked := false
	metrics := &mockAgentSessionMetricsObserver{}
	q := &mockAgentQuerier{getAgentSessionFn: func(context.Context, string) (db.AgentSession, error) { return row, nil }}
	dq := &mockAgentDispatchQuerier{updateAgentSessionTerminalStatusFn: func(_ context.Context, p db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
		require.Equal(t, "cancelled", p.Status)
		r := row
		r.Status = p.Status
		return r, nil
	}, getWorkflowTaskByRunIDFn: func(context.Context, int64) (db.WorkflowTask, error) {
		return db.WorkflowTask{VmID: pgtype.Text{String: "vm", Valid: true}}, nil
	}, updateWorkflowRunAgentTokenFn: func(_ context.Context, p db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
		revoked = !p.AgentTokenHash.Valid
		return db.WorkflowRun{}, nil
	}}
	s := NewAgentServiceWithPool(q, nil, WithAgentDispatchQuerier(dq), WithAgentSessionMetrics(metrics), WithAgentSandboxClient(&mockSandboxVMClient{deleteVMFn: func(context.Context, string) error { deleted = true; return nil }}))
	publisher := &recordingPublisher{}
	s.revocations = publisher
	require.NoError(t, s.CancelSession(context.Background(), row.ID, 7, "operator cancel"))
	events := publisher.all()
	require.Len(t, events, 1)
	require.EqualValues(t, 7, events[0].UserID)
	require.Equal(t, "operator cancel", events[0].Reason)
	require.True(t, deleted)
	require.True(t, revoked)
	require.Equal(t, []string{"cancelled"}, metrics.completions)
	require.Error(t, s.CancelSession(context.Background(), row.ID, 8, ""))
	dq.updateAgentSessionTerminalStatusFn = func(context.Context, db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
		return db.AgentSession{}, pgx.ErrNoRows
	}
	require.Error(t, s.CancelSession(context.Background(), row.ID, 7, ""))
	require.Len(t, metrics.completions, 1)
	row.Status = "completed"
	require.Error(t, s.CancelSession(context.Background(), row.ID, 7, ""))
}

func TestAdminManageAuditPrecedesEverySideEffect(t *testing.T) {
	for _, action := range []string{"cancel", "stop", "suspend", "drain"} {
		t.Run(action, func(t *testing.T) {
			f := &manageFake{session: db.AgentSession{Status: "active", UserID: 7}, workspace: db.Workspace{Status: "running", UserID: 8, RepositoryID: 4}}
			s := NewAdminManageService(f, f, f, f)
			run := func() error {
				switch action {
				case "cancel":
					_, err := s.CancelAgentSession(manageTestContext(), "original-id", "reason")
					return err
				case "stop":
					_, err := s.StopWorkspace(manageTestContext(), "original-id")
					return err
				case "suspend":
					_, err := s.SuspendWorkspace(manageTestContext(), "original-id")
					return err
				default:
					_, err := s.DrainSandboxHost(manageTestContext(), "original-id")
					return err
				}
			}
			f.auditErr = errors.New("audit unavailable")
			require.Error(t, run())
			require.Empty(t, f.action)
			require.Empty(t, f.audits)
			f.auditCalls = 0
			f.auditFailFrom = 2
			f.beforeAction = func() {
				require.Len(t, f.audits, 1)
				require.Contains(t, string(f.audits[0].Metadata), `"outcome":"attempted"`)
				require.Equal(t, "original-id", f.audits[0].TargetName)
			}
			// Outcome persistence fails after execution; immutable intent survives.
			require.Error(t, run())
			require.NotEmpty(t, f.action)
			require.Len(t, f.audits, 1)
			require.Equal(t, 4, f.auditCalls)
			original := f.audits[0]
			f.beforeAction = nil
			f.auditErr = nil
			require.NoError(t, run())
			require.Equal(t, original, f.audits[0])
			require.Len(t, f.audits, 3)
			var attempted, completed map[string]any
			require.NoError(t, json.Unmarshal(f.audits[1].Metadata, &attempted))
			require.NoError(t, json.Unmarshal(f.audits[2].Metadata, &completed))
			require.Equal(t, attempted["operation_id"], completed["operation_id"])
			require.Equal(t, "succeeded", completed["outcome"])
		})
	}
}

func TestAdminManageFailedActionKeepsAttemptAndOutcome(t *testing.T) {
	f := &manageFake{err: control.ErrHostNotDrainable}
	_, err := NewAdminManageService(f, f, f, f).DrainSandboxHost(manageTestContext(), "host")
	require.Error(t, err)
	require.Len(t, f.audits, 2)
	require.Contains(t, string(f.audits[0].Metadata), `"outcome":"attempted"`)
	require.Contains(t, string(f.audits[1].Metadata), `"outcome":"failed"`)
}
