package services

import (
	"context"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	// AdminSystemIncidentStateOpen selects active incidents needing attention:
	// neither acknowledged nor currently snoozed.
	AdminSystemIncidentStateOpen   = "open"
	AdminSystemIncidentStateActive = "active"
	// AdminSystemIncidentStateAll selects every incident regardless of state.
	AdminSystemIncidentStateAll = "all"

	// AdminSystemIncidentDefaultLimit is used when the caller does not ask for
	// a specific page size.
	AdminSystemIncidentDefaultLimit = 50
	// AdminSystemIncidentMaxLimit is the largest page size the endpoint serves.
	AdminSystemIncidentMaxLimit = 200
)

// AdminSystemIncidentActiveStates is the set of alert_incidents.state values
// that count as "active" for the admin incidents endpoint: the incident has not
// reached a terminal state, so an operator still has something to do about it.
// The same set gates admission/dedupe in AlertIncidentService, so the two
// surfaces agree on what "active" means.
var AdminSystemIncidentActiveStates = []string{"open", "remediating", "pr_opened"}

// AdminSystemIncidentListInput carries the validated query parameters for
// GET /api/admin/system/incidents.
type AdminSystemIncidentListInput struct {
	// State selects a lifecycle view. Empty means active.
	State  string
	Policy string
	// Limit is the maximum number of incidents to return. Zero means
	// AdminSystemIncidentDefaultLimit.
	Limit int
}

// AdminSystemIncidentListParams carries the lifecycle view and exact policy filter.
type AdminSystemIncidentListParams struct {
	State     string
	Policy    string
	PageLimit int32
}

// AdminSystemRemediationJobRow mirrors the sqlc-generated row for the
// remediation half of the listing in db/queries/admin_system.sql:
//
//	SELECT id, incident_id, status, attempts, workflow_run_id, created_at, updated_at
//	FROM alert_remediation_jobs
//	WHERE incident_id = ANY(sqlc.arg(incident_ids)::bigint[])
//	ORDER BY incident_id, created_at DESC;
//
// The column list is explicit on purpose: alert_remediation_jobs.dispatch_token
// authorizes the workflow outcome callback, so it must never reach a response
// path. Keeping it out of this struct keeps it out of this layer entirely.
type AdminSystemRemediationJobRow struct {
	ID            int64
	IncidentID    int64
	Status        string
	Attempts      int32
	WorkflowRunID pgtype.Int8
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// AdminSystemIncident is one alert incident with its remediation attempts
// attached, ready for serialization by the routes layer.
type AdminSystemIncident struct {
	ID             int64
	IncidentID     string
	Condition      string
	Source         string
	URL            string
	Runbook        string
	Occurrences    int32
	LastSeenAt     time.Time
	AcknowledgedAt *time.Time
	AcknowledgedBy *string
	SnoozedUntil   *time.Time
	ResolvedBy     *string
	ResolutionNote *string
	Policy         string
	State          string
	OpenedAt       time.Time
	ClosedAt       *time.Time
	Summary        string
	Remediations   []AdminSystemRemediation
}

// AdminSystemRemediation is one remediation job attached to an incident.
type AdminSystemRemediation struct {
	ID            int64
	State         string
	Attempts      int32
	WorkflowRunID *int64
	UpdatedAt     time.Time
}

// AdminSystemIncidentsQuerier is the database interface needed by
// AdminSystemIncidentsService. It is satisfied by *db.Queries once the
// admin_system.sql queries are generated.
type AdminSystemIncidentsQuerier interface {
	ListAlertIncidents(ctx context.Context, arg AdminSystemIncidentListParams) ([]db.AlertIncident, error)
	ListAlertRemediationJobsForIncidents(ctx context.Context, incidentIDs []int64) ([]AdminSystemRemediationJobRow, error)
}

// AdminSystemIncidentsService lists alert incidents for the admin system
// dashboard.
type AdminSystemIncidentsService interface {
	ListIncidents(ctx context.Context, input AdminSystemIncidentListInput) ([]AdminSystemIncident, error)
}

type adminSystemIncidentsService struct {
	queries AdminSystemIncidentsQuerier
}

// NewAdminSystemIncidentsService creates an AdminSystemIncidentsService backed
// by the given querier.
func NewAdminSystemIncidentsService(queries AdminSystemIncidentsQuerier) AdminSystemIncidentsService {
	return &adminSystemIncidentsService{queries: queries}
}

// ListIncidents returns incidents newest first with their remediation jobs
// attached. The remediation jobs are fetched in a single batched query keyed by
// the listed incident IDs, so the response costs two round trips regardless of
// how many incidents are returned.
func (s *adminSystemIncidentsService) ListIncidents(ctx context.Context, input AdminSystemIncidentListInput) ([]AdminSystemIncident, error) {
	state := input.State
	if state == "" {
		state = AdminSystemIncidentStateActive
	}
	if !ValidAdminIncidentState(state) {
		return nil, pkgerrors.BadRequest("invalid incident state")
	}

	limit := input.Limit
	if limit == 0 {
		limit = AdminSystemIncidentDefaultLimit
	}
	if limit < 0 || limit > AdminSystemIncidentMaxLimit {
		return nil, pkgerrors.BadRequest("invalid limit: must be between 1 and 200")
	}

	incidents, err := s.queries.ListAlertIncidents(ctx, AdminSystemIncidentListParams{
		State:     state,
		Policy:    input.Policy,
		PageLimit: ClampInt32(limit),
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to list alert incidents")
	}
	if len(incidents) == 0 {
		return []AdminSystemIncident{}, nil
	}

	ids := make([]int64, len(incidents))
	for i, inc := range incidents {
		ids[i] = inc.ID
	}

	jobs, err := s.queries.ListAlertRemediationJobsForIncidents(ctx, ids)
	if err != nil {
		return nil, pkgerrors.Internal("failed to list alert remediation jobs")
	}

	byIncident := groupAdminSystemRemediations(jobs)

	out := make([]AdminSystemIncident, len(incidents))
	for i, inc := range incidents {
		item := adminSystemIncident(inc, byIncident[inc.ID])
		out[i] = item
	}

	// The listing query already orders newest first; re-sorting here keeps the
	// contract ("newest first") true for any caller wiring in a different
	// query, and makes the ordering assertable without a live database.
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].OpenedAt.Equal(out[j].OpenedAt) {
			return out[i].OpenedAt.After(out[j].OpenedAt)
		}
		return out[i].ID > out[j].ID
	})

	return out, nil
}

// groupAdminSystemRemediations buckets remediation jobs by incident, newest
// attempt first. Jobs whose incident is not in the listing are dropped.
func groupAdminSystemRemediations(jobs []AdminSystemRemediationJobRow) map[int64][]AdminSystemRemediation {
	sorted := make([]AdminSystemRemediationJobRow, len(jobs))
	copy(sorted, jobs)
	sort.SliceStable(sorted, func(i, j int) bool {
		if !sorted[i].CreatedAt.Equal(sorted[j].CreatedAt) {
			return sorted[i].CreatedAt.After(sorted[j].CreatedAt)
		}
		return sorted[i].ID > sorted[j].ID
	})

	byIncident := make(map[int64][]AdminSystemRemediation, len(sorted))
	for _, job := range sorted {
		item := AdminSystemRemediation{
			ID:        job.ID,
			State:     job.Status,
			Attempts:  job.Attempts,
			UpdatedAt: job.UpdatedAt,
		}
		if job.WorkflowRunID.Valid {
			runID := job.WorkflowRunID.Int64
			item.WorkflowRunID = &runID
		}
		byIncident[job.IncidentID] = append(byIncident[job.IncidentID], item)
	}
	return byIncident
}

func ValidAdminIncidentState(state string) bool {
	switch state {
	case "active", "open", "acknowledged", "snoozed", "resolved", "all":
		return true
	}
	return false
}

func incidentTime(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	t := value.Time.UTC()
	return &t
}
func incidentText(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}
func adminSystemIncident(inc db.AlertIncident, jobs []AdminSystemRemediation) AdminSystemIncident {
	if jobs == nil {
		jobs = []AdminSystemRemediation{}
	}
	return AdminSystemIncident{
		ID: inc.ID, IncidentID: inc.IncidentID, Policy: inc.PolicyName, Condition: inc.ConditionName,
		State: inc.State, Source: inc.Source, Summary: inc.Summary, URL: inc.IncidentUrl, Runbook: inc.Runbook,
		Occurrences: inc.Occurrences, OpenedAt: inc.CreatedAt, LastSeenAt: inc.LastSeenAt,
		ClosedAt: incidentTime(inc.ResolvedAt), AcknowledgedAt: incidentTime(inc.AcknowledgedAt),
		AcknowledgedBy: incidentText(inc.AcknowledgedBy), SnoozedUntil: incidentTime(inc.SnoozedUntil),
		ResolvedBy: incidentText(inc.ResolvedBy), ResolutionNote: incidentText(inc.ResolutionNote), Remediations: jobs,
	}
}
