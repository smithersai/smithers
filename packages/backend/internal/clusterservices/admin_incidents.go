package clusterservices

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/deploymentdb"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// AdminIncidentsQuerier deliberately has no remediation enqueue capability.
type AdminIncidentsQuerier interface {
	services.AuditQueries
	GetAlertIncidentForUpdate(context.Context, int64) (clusterdb.AlertIncident, error)
	AdminMutateAlertIncidents(context.Context, clusterdb.AdminMutateAlertIncidentsParams) ([]clusterdb.AlertIncident, error)
	ListAlertRemediationJobsForIncidents(context.Context, []int64) ([]clusterdb.ListAlertRemediationJobsForIncidentsRow, error)
}

type incidentTransactionalQuerier interface {
	BeginTx(context.Context) (pgx.Tx, error)
	WithTx(pgx.Tx) *deploymentdb.Queries
}

type AdminIncidentBulkInput struct {
	Action string     `json:"action"`
	IDs    []int64    `json:"ids"`
	Policy *string    `json:"policy"`
	Note   *string    `json:"note"`
	Until  *time.Time `json:"until"`
}

type AdminIncidentsService struct {
	queries             AdminIncidentsQuerier
	requireTransactions bool
	now                 func() time.Time
}

// NewHostedAdminIncidentsService requires mutations and audit writes to share a transaction.
func NewHostedAdminIncidentsService(q *deploymentdb.Queries) *AdminIncidentsService {
	return &AdminIncidentsService{queries: q, now: time.Now, requireTransactions: true}
}

var _ incidentTransactionalQuerier = (*deploymentdb.Queries)(nil)

func NewAdminIncidentsService(q AdminIncidentsQuerier) *AdminIncidentsService {
	return &AdminIncidentsService{queries: q, now: time.Now}
}

func (s *AdminIncidentsService) Acknowledge(ctx context.Context, id int64, note *string) (AdminSystemIncident, error) {
	return s.single(ctx, id, AdminIncidentBulkInput{Action: "acknowledge", Note: note})
}
func (s *AdminIncidentsService) Unacknowledge(ctx context.Context, id int64) (AdminSystemIncident, error) {
	return s.single(ctx, id, AdminIncidentBulkInput{Action: "unacknowledge"})
}
func (s *AdminIncidentsService) Resolve(ctx context.Context, id int64, note *string) (AdminSystemIncident, error) {
	return s.single(ctx, id, AdminIncidentBulkInput{Action: "resolve", Note: note})
}
func (s *AdminIncidentsService) Snooze(ctx context.Context, id int64, until time.Time) (AdminSystemIncident, error) {
	return s.single(ctx, id, AdminIncidentBulkInput{Action: "snooze", Until: &until})
}

func (s *AdminIncidentsService) validate(input AdminIncidentBulkInput, bulk bool) error {
	switch input.Action {
	case "acknowledge", "resolve", "snooze":
	case "unacknowledge":
		if bulk {
			return pkgerrors.BadRequest("invalid bulk action")
		}
	default:
		return pkgerrors.BadRequest("invalid incident action")
	}
	if (input.IDs != nil) == (input.Policy != nil) {
		return pkgerrors.BadRequest("exactly one of ids or policy is required")
	}
	if input.IDs != nil {
		if len(input.IDs) == 0 {
			return pkgerrors.BadRequest("ids must not be empty")
		}
		for _, id := range input.IDs {
			if id <= 0 {
				return pkgerrors.BadRequest("incident ids must be positive")
			}
		}
	}
	if input.Policy != nil && strings.TrimSpace(*input.Policy) == "" {
		return pkgerrors.BadRequest("policy must not be empty")
	}
	if input.Action == "snooze" {
		now := s.now()
		if input.Until == nil || !input.Until.After(now) || input.Until.After(now.Add(7*24*time.Hour)) {
			return pkgerrors.BadRequest("until must be in the future and at most 7 days away")
		}
	}
	return nil
}

// Every mutation and its audit row commit together in production. Fakes use
// the same query interface without needing a PostgreSQL transaction.
func (s *AdminIncidentsService) transaction(ctx context.Context, fn func(AdminIncidentsQuerier) error) error {
	if txq, ok := s.queries.(incidentTransactionalQuerier); ok {
		tx, err := txq.BeginTx(ctx)
		if err != nil {
			return pkgerrors.Internal("failed to begin incident mutation").WithCause(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if err := fn(txq.WithTx(tx)); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return pkgerrors.Internal("failed to commit incident mutation").WithCause(err)
		}
		return nil
	}
	if s.requireTransactions {
		return pkgerrors.Internal("incident store requires transactions")
	}
	return fn(s.queries)
}

func (s *AdminIncidentsService) single(ctx context.Context, id int64, input AdminIncidentBulkInput) (AdminSystemIncident, error) {
	var out AdminSystemIncident
	input.IDs = []int64{id}
	if err := s.validate(input, false); err != nil {
		return out, err
	}
	actor, ok := services.AdminAuditActorFromContext(ctx)
	if !ok || actor.UserID <= 0 {
		return out, pkgerrors.Unauthorized("admin actor is required")
	}
	err := s.transaction(ctx, func(q AdminIncidentsQuerier) error {
		row, err := q.GetAlertIncidentForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("alert incident not found")
		}
		if err != nil {
			return pkgerrors.Internal("failed to load alert incident").WithCause(err)
		}
		if !(input.Action == "resolve" && row.State == "resolved") {
			if row.State == "resolved" || (row.State == "failed" && input.Action != "resolve") {
				return pkgerrors.Conflict("incident is no longer active")
			}
			rows, err := q.AdminMutateAlertIncidents(ctx, incidentMutationParams(input, actor))
			if err != nil {
				return pkgerrors.Internal("failed to update alert incident").WithCause(err)
			}
			if len(rows) != 1 {
				return pkgerrors.Conflict("incident is no longer active")
			}
			row = rows[0]
		}
		jobs, err := q.ListAlertRemediationJobsForIncidents(ctx, []int64{id})
		if err != nil {
			return pkgerrors.Internal("failed to list alert remediation jobs").WithCause(err)
		}
		mapped := make([]AdminSystemRemediationJobRow, len(jobs))
		for i, j := range jobs {
			mapped[i] = AdminSystemRemediationJobRow{ID: j.ID, IncidentID: j.IncidentID, Status: j.Status, Attempts: j.Attempts, WorkflowRunID: j.WorkflowRunID, CreatedAt: j.CreatedAt, UpdatedAt: j.UpdatedAt}
		}
		out = adminSystemIncident(row, groupAdminSystemRemediations(mapped)[id])
		return logIncidentAudit(ctx, q, actor, input, &id, false, 1)
	})
	return out, err
}

func (s *AdminIncidentsService) Bulk(ctx context.Context, input AdminIncidentBulkInput) (int64, error) {
	if err := s.validate(input, true); err != nil {
		return 0, err
	}
	actor, ok := services.AdminAuditActorFromContext(ctx)
	if !ok || actor.UserID <= 0 {
		return 0, pkgerrors.Unauthorized("admin actor is required")
	}
	var affected int64
	err := s.transaction(ctx, func(q AdminIncidentsQuerier) error {
		rows, err := q.AdminMutateAlertIncidents(ctx, incidentMutationParams(input, actor))
		if err != nil {
			return pkgerrors.Internal("failed to update alert incidents").WithCause(err)
		}
		affected = int64(len(rows))
		return logIncidentAudit(ctx, q, actor, input, nil, true, affected)
	})
	if err != nil {
		return 0, err
	}
	return affected, nil
}

func incidentMutationParams(input AdminIncidentBulkInput, actor services.AdminAuditActor) clusterdb.AdminMutateAlertIncidentsParams {
	p := clusterdb.AdminMutateAlertIncidentsParams{Action: input.Action, Actor: actor.Username, Ids: input.IDs}
	if input.Policy != nil {
		p.Policy = pgtype.Text{String: *input.Policy, Valid: true}
	}
	if input.Note != nil {
		p.Note = pgtype.Text{String: *input.Note, Valid: true}
	}
	if input.Until != nil {
		p.Until = pgtype.Timestamptz{Time: input.Until.UTC(), Valid: true}
	}
	return p
}

// services.AuditService supplies the established event encoding. Capture its write
// error so this administrative action cannot succeed without a durable audit.
type incidentAuditWriter struct {
	services.AuditQueries
	err error
}

func (w *incidentAuditWriter) InsertAuditLog(ctx context.Context, p db.InsertAuditLogParams) error {
	w.err = w.AuditQueries.InsertAuditLog(ctx, p)
	return w.err
}
func logIncidentAudit(ctx context.Context, q services.AuditQueries, actor services.AdminAuditActor, input AdminIncidentBulkInput, id *int64, bulk bool, affected int64) error {
	event := "admin.incident."
	if bulk {
		event += "bulk_"
	}
	writer := &incidentAuditWriter{AuditQueries: q}
	services.NewAuditService(writer).Log(ctx, services.AuditEvent{
		EventType: event + input.Action, ActorID: &actor.UserID, ActorName: actor.Username, IPAddress: actor.IPAddress,
		TargetType: "alert_incident", TargetID: id, Action: input.Action,
		Metadata: map[string]any{"ids": input.IDs, "policy": input.Policy, "note": input.Note, "until": input.Until, "affected": affected},
	})
	if writer.err != nil {
		return pkgerrors.Internal("failed to audit incident mutation")
	}
	return nil
}
