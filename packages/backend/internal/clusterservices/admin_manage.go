package clusterservices

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"

	"github.com/smithersai/smithers/packages/backend/internal/services"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/microsandbox/control"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type AdminManageQuerier interface {
	AdminListAgentSessions(context.Context, db.AdminListAgentSessionsParams) ([]db.AdminListAgentSessionsRow, error)
	AdminListWorkspaces(context.Context, db.AdminListWorkspacesParams) ([]db.AdminListWorkspacesRow, error)
	AdminListSandboxHosts(context.Context) ([]clusterdb.AdminListSandboxHostsRow, error)
	AdminListTokens(context.Context, db.AdminListTokensParams) ([]db.AdminListTokensRow, error)
	AdminPruneStaleSandboxHosts(context.Context, clusterdb.AdminPruneStaleSandboxHostsParams) (int64, error)
	GetAgentSession(context.Context, string) (db.AgentSession, error)
	GetWorkspace(context.Context, string) (db.Workspace, error)
	InsertAuditLog(context.Context, db.InsertAuditLogParams) error
}
type AdminAgentCanceller interface {
	CancelSession(context.Context, string, int64, string) error
}
type AdminWorkspaceLifecycle interface {
	StopWorkspace(context.Context, string, int64, int64) (services.WorkspaceResponse, error)
	SuspendWorkspace(context.Context, string, int64, int64) (services.WorkspaceResponse, error)
}
type AdminHostDrainer interface {
	DrainHost(context.Context, string) error
}
type AdminManageService struct {
	q          AdminManageQuerier
	agents     AdminAgentCanceller
	workspaces AdminWorkspaceLifecycle
	hosts      AdminHostDrainer
}

func NewAdminManageService(q AdminManageQuerier, agents AdminAgentCanceller, workspaces AdminWorkspaceLifecycle, hosts AdminHostDrainer) *AdminManageService {
	return &AdminManageService{q: q, agents: agents, workspaces: workspaces, hosts: hosts}
}

type AdminAgentSession struct {
	ID            string     `json:"id"`
	Status        string     `json:"status"`
	User          string     `json:"user"`
	Repository    string     `json:"repository"`
	WorkspaceID   *string    `json:"workspace_id"`
	WorkflowRunID *string    `json:"workflow_run_id"`
	CreatedAt     time.Time  `json:"created_at"`
	StartedAt     *time.Time `json:"started_at"`
	FinishedAt    *time.Time `json:"finished_at"`
	AgeSeconds    int64      `json:"age_seconds"`
}
type AdminWorkspace struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	Kind           string    `json:"kind"`
	Status         string    `json:"status"`
	Owner          string    `json:"owner"`
	Repository     string    `json:"repository"`
	CreatedAt      time.Time `json:"created_at"`
	LastActivityAt time.Time `json:"last_activity_at"`
	FailureCode    *string   `json:"failure_code"`
	FailureMessage *string   `json:"failure_message"`
	VMID           string    `json:"vm_id"`
}
type AdminHostResources struct {
	CPUMillis   int64 `json:"cpu_millis,string"`
	MemoryBytes int64 `json:"memory_bytes,string"`
	DiskBytes   int64 `json:"disk_bytes,string"`
	VMs         int32 `json:"vms"`
}
type AdminSandboxHost struct {
	ID                  string             `json:"id"`
	WorkerID            string             `json:"worker_id"`
	State               string             `json:"state"`
	Capacity            AdminHostResources `json:"capacity"`
	Allocated           AdminHostResources `json:"allocated"`
	Observed            AdminHostResources `json:"observed"`
	HeartbeatAt         time.Time          `json:"heartbeat_at"`
	HeartbeatAgeSeconds int64              `json:"heartbeat_age_seconds"`
	LeaseExpiresAt      time.Time          `json:"lease_expires_at"`
	RuntimeVersion      string             `json:"runtime_version"`
}
type AdminToken struct {
	ID         int64      `json:"id,string"`
	Name       string     `json:"name"`
	User       string     `json:"user"`
	Scopes     string     `json:"scopes"`
	LastUsedAt *time.Time `json:"last_used_at"`
	ExpiresAt  *time.Time `json:"expires_at"`
	CreatedAt  time.Time  `json:"created_at"`
}
type AdminManageStatus struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}
type AdminHostState struct {
	ID    string `json:"id"`
	State string `json:"state"`
}
type AdminPruneResult struct {
	Pruned int64 `json:"pruned"`
}

func manageTime(v pgtype.Timestamptz) *time.Time {
	if !v.Valid {
		return nil
	}
	t := v.Time.UTC()
	return &t
}
func manageText(v pgtype.Text) *string {
	if !v.Valid {
		return nil
	}
	return &v.String
}
func manageLimit(n *int32, max int32) error {
	if *n == 0 {
		*n = 100
	}
	if *n < 1 || *n > max {
		return pkgerrors.BadRequest("limit out of range")
	}
	return nil
}

func (s *AdminManageService) ListAgentSessions(ctx context.Context, p db.AdminListAgentSessionsParams) ([]AdminAgentSession, error) {
	if p.Status == "" {
		p.Status = "active"
	}
	if p.Status != "active" && p.Status != "all" {
		return nil, pkgerrors.BadRequest("status must be active or all")
	}
	if err := manageLimit(&p.RowLimit, 200); err != nil {
		return nil, err
	}
	rows, err := s.q.AdminListAgentSessions(ctx, p)
	if err != nil {
		return nil, services.ResourceStoreError(err, "agent sessions")
	}
	out := make([]AdminAgentSession, 0, len(rows))
	now := time.Now()
	for _, r := range rows {
		a := r.AgentSession
		v := AdminAgentSession{
			ID: a.ID, Status: a.Status, User: r.Username, Repository: r.Repository,
			CreatedAt: a.CreatedAt.UTC(), StartedAt: manageTime(a.StartedAt),
			FinishedAt: manageTime(a.FinishedAt), AgeSeconds: max(0, int64(now.Sub(a.CreatedAt).Seconds())),
		}
		if a.WorkspaceID.Valid {
			id := services.UUIDString(a.WorkspaceID)
			v.WorkspaceID = &id
		}
		if a.WorkflowRunID.Valid {
			id := strconv.FormatInt(a.WorkflowRunID.Int64, 10)
			v.WorkflowRunID = &id
		}
		out = append(out, v)
	}
	return out, nil
}
func (s *AdminManageService) ListWorkspaces(ctx context.Context, p db.AdminListWorkspacesParams) ([]AdminWorkspace, error) {
	if err := manageLimit(&p.RowLimit, 200); err != nil {
		return nil, err
	}
	switch p.Status {
	case "", "pending", "starting", "running", "suspended", "stopped", "failed":
	default:
		return nil, pkgerrors.BadRequest("invalid workspace status")
	}
	switch p.Kind {
	case "", "container", "vm", "desktop", "agent":
	default:
		return nil, pkgerrors.BadRequest("invalid workspace kind")
	}
	p.Owner = strings.TrimSpace(p.Owner)
	rows, err := s.q.AdminListWorkspaces(ctx, p)
	if err != nil {
		return nil, services.ResourceStoreError(err, "workspaces")
	}
	out := make([]AdminWorkspace, 0, len(rows))
	for _, r := range rows {
		w := r.Workspace
		out = append(out, AdminWorkspace{
			ID: w.ID, Name: w.Name, Kind: w.Kind, Status: w.Status,
			Owner: r.Owner, Repository: r.Repository, VMID: w.VmID,
			CreatedAt: w.CreatedAt.UTC(), LastActivityAt: w.LastActivityAt.UTC(),
			FailureCode: manageText(w.FailureCode), FailureMessage: manageText(w.FailureMessage),
		})
	}
	return out, nil
}
func (s *AdminManageService) ListSandboxHosts(ctx context.Context) ([]AdminSandboxHost, error) {
	rows, err := s.q.AdminListSandboxHosts(ctx)
	if err != nil {
		return nil, services.ResourceStoreError(err, "sandbox hosts")
	}
	out := make([]AdminSandboxHost, 0, len(rows))
	now := time.Now()
	for _, r := range rows {
		h := r.SandboxHost
		out = append(out, AdminSandboxHost{
			ID: h.ID, WorkerID: h.ID, State: h.State,
			Capacity:    AdminHostResources{h.CapacityCpuMillis, h.CapacityMemoryBytes, h.CapacityDiskBytes, h.CapacityVms},
			Allocated:   AdminHostResources{h.AllocatedCpuMillis, h.AllocatedMemoryBytes, h.AllocatedDiskBytes, h.AllocatedVms},
			Observed:    AdminHostResources{h.ObservedAllocatedCpuMillis, h.ObservedAllocatedMemoryBytes, h.ObservedAllocatedDiskBytes, h.ObservedAllocatedVms},
			HeartbeatAt: h.HeartbeatAt.UTC(), HeartbeatAgeSeconds: max(0, int64(now.Sub(h.HeartbeatAt).Seconds())),
			LeaseExpiresAt: h.LeaseExpiresAt.UTC(), RuntimeVersion: h.RuntimeVersion,
		})
	}
	return out, nil
}
func (s *AdminManageService) ListTokens(ctx context.Context, p db.AdminListTokensParams) ([]AdminToken, error) {
	if err := manageLimit(&p.RowLimit, 500); err != nil {
		return nil, err
	}
	if p.UnusedDays < 0 || p.ExpiringDays < 0 || p.UnusedDays > 365000 || p.ExpiringDays > 365000 {
		return nil, pkgerrors.BadRequest("days out of range")
	}
	rows, err := s.q.AdminListTokens(ctx, p)
	if err != nil {
		return nil, services.ResourceStoreError(err, "tokens")
	}
	out := make([]AdminToken, 0, len(rows))
	for _, r := range rows {
		out = append(out, AdminToken{ID: r.ID, Name: r.Name, User: r.Username, Scopes: r.Scopes, LastUsedAt: manageTime(r.LastUsedAt), ExpiresAt: manageTime(r.ExpiresAt), CreatedAt: r.CreatedAt.UTC()})
	}
	return out, nil
}
func manageActor(ctx context.Context) error {
	a, ok := services.AdminAuditActorFromContext(ctx)
	if !ok || a.UserID <= 0 {
		return pkgerrors.Unauthorized("admin actor required")
	}
	return nil
}
func (s *AdminManageService) audit(ctx context.Context, target, id, action string, metadata map[string]any) error {
	a, _ := services.AdminAuditActorFromContext(ctx)
	body, err := json.Marshal(metadata)
	if err != nil {
		return pkgerrors.Internal("encode admin audit")
	}
	auditCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err = s.q.InsertAuditLog(auditCtx, db.InsertAuditLogParams{EventType: "admin." + target + "." + action, ActorID: pgtype.Int8{Int64: a.UserID, Valid: true}, ActorName: a.Username, TargetType: target, TargetName: id, Action: action, Metadata: body, IpAddress: a.IPAddress}); err != nil {
		return pkgerrors.Internal("record admin audit")
	}
	return nil
}

// auditedOperation commits intent before any external action. Both records share
// an operation ID and immutable target metadata. If the process dies or outcome
// persistence fails, the attempted record remains for operator reconciliation.
func (s *AdminManageService) auditedOperation(ctx context.Context, target, id, action string, metadata map[string]any, run func() error) error {
	metadata["operation_id"] = uuid.NewString()
	metadata["outcome"] = "attempted"
	if err := s.audit(ctx, target, id, action, metadata); err != nil {
		return err
	}
	operationErr := run()
	metadata["outcome"] = "succeeded"
	if operationErr != nil {
		metadata["outcome"] = "failed"
	}
	// Retry completion writes independently of client cancellation. The durable
	// attempt is never replaced, even if all completion writes fail.
	var auditErr error
	for attempt := 0; attempt < 3; attempt++ {
		auditErr = s.audit(ctx, target, id, action, metadata)
		if auditErr == nil {
			break
		}
	}
	if auditErr != nil {
		slog.Error("admin operation outcome audit failed; durable attempt requires reconciliation", "operation_id", metadata["operation_id"], "target", id, "action", action)
	}
	if operationErr != nil {
		return operationErr
	}
	return auditErr
}

func (s *AdminManageService) CancelAgentSession(ctx context.Context, id, reason string) (AdminManageStatus, error) {
	if err := manageActor(ctx); err != nil {
		return AdminManageStatus{}, err
	}
	if len(reason) > 4096 {
		return AdminManageStatus{}, pkgerrors.BadRequest("reason exceeds 4096 bytes")
	}
	row, err := s.q.GetAgentSession(ctx, id)
	if err != nil {
		return AdminManageStatus{}, services.ResourceStoreError(err, "agent session")
	}
	if row.Status != "active" {
		return AdminManageStatus{}, pkgerrors.Conflict("agent session is not active")
	}
	if s.agents == nil {
		return AdminManageStatus{}, pkgerrors.Internal("agent service unavailable")
	}
	err = s.auditedOperation(ctx, "agent_session", id, "cancel", map[string]any{"reason": reason, "owner_id": strconv.FormatInt(row.UserID, 10)}, func() error {
		return s.agents.CancelSession(ctx, id, row.UserID, reason)
	})
	return AdminManageStatus{ID: id, Status: "cancelled"}, err
}
func (s *AdminManageService) StopWorkspace(ctx context.Context, id string) (AdminManageStatus, error) {
	return s.changeWorkspace(ctx, id, false)
}
func (s *AdminManageService) SuspendWorkspace(ctx context.Context, id string) (AdminManageStatus, error) {
	return s.changeWorkspace(ctx, id, true)
}
func (s *AdminManageService) changeWorkspace(ctx context.Context, id string, suspend bool) (AdminManageStatus, error) {
	if err := manageActor(ctx); err != nil {
		return AdminManageStatus{}, err
	}
	row, err := s.q.GetWorkspace(ctx, id)
	if err != nil {
		return AdminManageStatus{}, services.ResourceStoreError(err, "workspace")
	}
	if row.Status == "stopped" || (suspend && row.Status != "running") {
		return AdminManageStatus{}, pkgerrors.Conflict("invalid workspace state transition")
	}
	if s.workspaces == nil {
		return AdminManageStatus{}, pkgerrors.Internal("workspace service unavailable")
	}
	action, expected := "stop", "stopped"
	if suspend {
		action, expected = "suspend", "suspended"
	}
	var result services.WorkspaceResponse
	err = s.auditedOperation(ctx, "workspace", id, action, map[string]any{"owner_id": strconv.FormatInt(row.UserID, 10)}, func() error {
		var lifecycleErr error
		if suspend {
			result, lifecycleErr = s.workspaces.SuspendWorkspace(ctx, id, row.RepositoryID, row.UserID)
		} else {
			result, lifecycleErr = s.workspaces.StopWorkspace(ctx, id, row.RepositoryID, row.UserID)
		}
		if lifecycleErr == nil && result.Status != expected {
			return pkgerrors.Conflict("workspace did not enter " + expected + " state")
		}
		return lifecycleErr
	})
	return AdminManageStatus{ID: id, Status: result.Status}, err
}
func (s *AdminManageService) DrainSandboxHost(ctx context.Context, id string) (AdminHostState, error) {
	if err := manageActor(ctx); err != nil {
		return AdminHostState{}, err
	}
	if s.hosts == nil {
		return AdminHostState{}, pkgerrors.Internal("sandbox control store unavailable")
	}
	err := s.auditedOperation(ctx, "sandbox_host", id, "drain", map[string]any{}, func() error {
		if err := s.hosts.DrainHost(ctx, id); err != nil {
			// A lost lease and an undrainable state are different verdicts:
			// the first is plue losing a host, the second is the operator
			// asking for something that does not apply. They used to share a
			// 409 that blamed the operator for both.
			if errors.Is(err, control.ErrHostLeaseLost) {
				return pkgerrors.New(pkgerrors.CodeHostLeaseLost,
					"the controller's lease on this host has expired; it is no longer ours to drain")
			}
			if errors.Is(err, control.ErrHostNotDrainable) {
				return pkgerrors.Conflict("host is not in a drainable state")
			}
			return services.ResourceStoreError(err, "sandbox host")
		}
		return nil
	})
	return AdminHostState{ID: id, State: "draining"}, err
}
func (s *AdminManageService) PruneStaleSandboxHosts(ctx context.Context, hours int32) (AdminPruneResult, error) {
	if err := manageActor(ctx); err != nil {
		return AdminPruneResult{}, err
	}
	if hours == 0 {
		hours = 24
	}
	if hours < 1 || hours > 876000 {
		return AdminPruneResult{}, pkgerrors.BadRequest("older_than_hours out of range")
	}
	actor, _ := services.AdminAuditActorFromContext(ctx)
	n, err := s.q.AdminPruneStaleSandboxHosts(ctx, clusterdb.AdminPruneStaleSandboxHostsParams{
		OlderThanHours: hours, ActorID: pgtype.Int8{Int64: actor.UserID, Valid: true}, ActorName: actor.Username, IpAddress: actor.IPAddress,
	})
	if err != nil {
		return AdminPruneResult{}, pkgerrors.Internal("prune stale sandbox hosts and record audit")
	}
	return AdminPruneResult{Pruned: n}, nil
}
