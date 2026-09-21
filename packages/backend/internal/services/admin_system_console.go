package services

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// AdminSystemConsoleQuerier is the generated query surface the admin system
// console reads. *db.Queries satisfies it directly; the interface exists so the
// adapter can be exercised without a database.
type AdminSystemConsoleQuerier interface {
	ListAlertIncidents(ctx context.Context, arg db.ListAlertIncidentsParams) ([]db.AlertIncident, error)
	ListAlertRemediationJobsForIncidents(ctx context.Context, incidentIDs []int64) ([]db.ListAlertRemediationJobsForIncidentsRow, error)
	GetLandingQueueDepth(ctx context.Context) (int64, error)
}

// AdminSystemConsoleStore adapts the generated queries to the dependency
// interfaces the admin system console services declare. Those services were
// written against their own parameter and row types so they do not depend on
// sqlc regeneration order, so a thin field-for-field translation lives here
// rather than in cmd/server.
//
// It satisfies AdminSystemIncidentsQuerier (the incidents endpoint) and
// AdminSystemStatusLandingQueueCounter (the status aggregate).
type AdminSystemConsoleStore struct {
	queries AdminSystemConsoleQuerier
}

var (
	_ AdminSystemIncidentsQuerier          = (*AdminSystemConsoleStore)(nil)
	_ AdminSystemStatusLandingQueueCounter = (*AdminSystemConsoleStore)(nil)
)

// NewAdminSystemConsoleStore creates the admin system console database adapter.
func NewAdminSystemConsoleStore(queries AdminSystemConsoleQuerier) *AdminSystemConsoleStore {
	return &AdminSystemConsoleStore{queries: queries}
}

// ListAlertIncidents lists incidents newest first, optionally restricted to the
// non-terminal states in AdminSystemIncidentActiveStates.
func (s *AdminSystemConsoleStore) ListAlertIncidents(ctx context.Context, arg AdminSystemIncidentListParams) ([]db.AlertIncident, error) {
	return s.queries.ListAlertIncidents(ctx, db.ListAlertIncidentsParams{
		StateFilter: arg.State,
		Policy:      pgtype.Text{String: arg.Policy, Valid: arg.Policy != ""},
		PageLimit:   arg.PageLimit,
	})
}

// ListAlertRemediationJobsForIncidents fetches every remediation job attached to
// the given incidents in one round trip.
//
// The generated row carries columns this layer does not need; only the fields
// the response exposes are copied across. alert_remediation_jobs.dispatch_token
// is not selected by the query at all, so it can never reach a response.
func (s *AdminSystemConsoleStore) ListAlertRemediationJobsForIncidents(ctx context.Context, incidentIDs []int64) ([]AdminSystemRemediationJobRow, error) {
	rows, err := s.queries.ListAlertRemediationJobsForIncidents(ctx, incidentIDs)
	if err != nil {
		return nil, err
	}

	out := make([]AdminSystemRemediationJobRow, len(rows))
	for i, row := range rows {
		out[i] = AdminSystemRemediationJobRow{
			ID:            row.ID,
			IncidentID:    row.IncidentID,
			Status:        row.Status,
			Attempts:      row.Attempts,
			WorkflowRunID: row.WorkflowRunID,
			CreatedAt:     row.CreatedAt,
			UpdatedAt:     row.UpdatedAt,
		}
	}
	return out, nil
}

// CountQueuedLandingTasks returns the landing queue depth.
//
// The query counts landing_tasks rows in 'pending' or 'append_pending', including tasks
// whose retry backoff has not elapsed: work that is queued but not yet
// claimable is still queued. Tasks already claimed by a worker are running, not
// queued, and are not counted.
func (s *AdminSystemConsoleStore) CountQueuedLandingTasks(ctx context.Context) (int64, error) {
	return s.queries.GetLandingQueueDepth(ctx)
}
