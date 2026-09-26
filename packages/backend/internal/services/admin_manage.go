package services

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// AdminManageQuerier is the product query surface behind the operator
// management endpoints.
type AdminManageQuerier interface {
	AdminListAgentSessions(context.Context, db.AdminListAgentSessionsParams) ([]db.AdminListAgentSessionsRow, error)
	AdminListWorkspaces(context.Context, db.AdminListWorkspacesParams) ([]db.AdminListWorkspacesRow, error)
	AdminListTokens(context.Context, db.AdminListTokensParams) ([]db.AdminListTokensRow, error)
	GetAgentSession(context.Context, string) (db.AgentSession, error)
	GetWorkspace(context.Context, string) (db.Workspace, error)
	InsertAuditLog(context.Context, db.InsertAuditLogParams) error
}

// AdminAgentCanceller cancels an agent session on its owner's behalf.
type AdminAgentCanceller interface {
	CancelSession(context.Context, string, int64, string) error
}

// AdminWorkspaceLifecycle stops or suspends a workspace on its owner's behalf.
type AdminWorkspaceLifecycle interface {
	StopWorkspace(context.Context, string, int64, int64) (WorkspaceResponse, error)
	SuspendWorkspace(context.Context, string, int64, int64) (WorkspaceResponse, error)
}

// AdminManageService lists and changes agent sessions, workspaces, and
// tokens across every owner. Every mutation is audited before it runs.
type AdminManageService struct {
	q          AdminManageQuerier
	agents     AdminAgentCanceller
	workspaces AdminWorkspaceLifecycle
	log        *AdminOperationLog
}

func NewAdminManageService(q AdminManageQuerier, agents AdminAgentCanceller, workspaces AdminWorkspaceLifecycle) *AdminManageService {
	return &AdminManageService{q: q, agents: agents, workspaces: workspaces, log: NewAdminOperationLog(q)}
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

func manageStoreError(err error, resource string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.NotFound(resource + " not found")
	}
	return pkgerrors.Internal("could not load " + resource)
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
		return nil, manageStoreError(err, "agent sessions")
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
			id := UUIDString(a.WorkspaceID)
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
		return nil, manageStoreError(err, "workspaces")
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

func (s *AdminManageService) ListTokens(ctx context.Context, p db.AdminListTokensParams) ([]AdminToken, error) {
	if err := manageLimit(&p.RowLimit, 500); err != nil {
		return nil, err
	}
	if p.UnusedDays < 0 || p.ExpiringDays < 0 || p.UnusedDays > 365000 || p.ExpiringDays > 365000 {
		return nil, pkgerrors.BadRequest("days out of range")
	}
	rows, err := s.q.AdminListTokens(ctx, p)
	if err != nil {
		return nil, manageStoreError(err, "tokens")
	}
	out := make([]AdminToken, 0, len(rows))
	for _, r := range rows {
		out = append(out, AdminToken{ID: r.ID, Name: r.Name, User: r.Username, Scopes: r.Scopes, LastUsedAt: manageTime(r.LastUsedAt), ExpiresAt: manageTime(r.ExpiresAt), CreatedAt: r.CreatedAt.UTC()})
	}
	return out, nil
}

func (s *AdminManageService) CancelAgentSession(ctx context.Context, id, reason string) (AdminManageStatus, error) {
	if err := requireAdminActor(ctx); err != nil {
		return AdminManageStatus{}, err
	}
	if len(reason) > 4096 {
		return AdminManageStatus{}, pkgerrors.BadRequest("reason exceeds 4096 bytes")
	}
	row, err := s.q.GetAgentSession(ctx, id)
	if err != nil {
		return AdminManageStatus{}, manageStoreError(err, "agent session")
	}
	if row.Status != "active" {
		return AdminManageStatus{}, pkgerrors.Conflict("agent session is not active")
	}
	if s.agents == nil {
		return AdminManageStatus{}, pkgerrors.Internal("agent service unavailable")
	}
	err = s.log.Operation(ctx, "agent_session", id, "cancel", map[string]any{"reason": reason, "owner_id": strconv.FormatInt(row.UserID, 10)}, func() error {
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
	if err := requireAdminActor(ctx); err != nil {
		return AdminManageStatus{}, err
	}
	row, err := s.q.GetWorkspace(ctx, id)
	if err != nil {
		return AdminManageStatus{}, manageStoreError(err, "workspace")
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
	var result WorkspaceResponse
	err = s.log.Operation(ctx, "workspace", id, action, map[string]any{"owner_id": strconv.FormatInt(row.UserID, 10)}, func() error {
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
