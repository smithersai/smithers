package clusterservices

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/services"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type fakeAdminIncidents struct {
	row                                  db.AlertIncident
	getErr, mutateErr, jobsErr, auditErr error
	mutations                            []db.AdminMutateAlertIncidentsParams
	audits                               []db.InsertAuditLogParams
	rows                                 []db.AlertIncident
}

func (q *fakeAdminIncidents) GetAlertIncidentForUpdate(context.Context, int64) (db.AlertIncident, error) {
	return q.row, q.getErr
}
func (q *fakeAdminIncidents) AdminMutateAlertIncidents(_ context.Context, p db.AdminMutateAlertIncidentsParams) ([]db.AlertIncident, error) {
	q.mutations = append(q.mutations, p)
	if q.rows != nil {
		return q.rows, q.mutateErr
	}
	return []db.AlertIncident{q.row}, q.mutateErr
}
func (q *fakeAdminIncidents) ListAlertRemediationJobsForIncidents(context.Context, []int64) ([]db.ListAlertRemediationJobsForIncidentsRow, error) {
	return []db.ListAlertRemediationJobsForIncidentsRow{{ID: 4, IncidentID: 1, Status: "done", WorkflowRunID: pgtype.Int8{Int64: 9007199254740993, Valid: true}}}, q.jobsErr
}
func (q *fakeAdminIncidents) InsertAuditLog(_ context.Context, p db.InsertAuditLogParams) error {
	q.audits = append(q.audits, p)
	return q.auditErr
}
func incidentAdminContext() context.Context {
	return services.ContextWithAdminAuditActor(context.Background(), services.AdminAuditActor{UserID: 7, Username: "operator", IPAddress: "127.0.0.1"})
}

func TestAdminIncidentsActions(t *testing.T) {
	now := time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC)
	until := now.Add(time.Hour)
	note := "investigated"
	for _, action := range []string{"acknowledge", "unacknowledge", "resolve", "snooze"} {
		t.Run(action, func(t *testing.T) {
			q := &fakeAdminIncidents{row: db.AlertIncident{ID: 1, State: "open", Source: "canary", Occurrences: 3}}
			s := NewAdminIncidentsService(q)
			s.now = func() time.Time { return now }
			var result AdminSystemIncident
			var err error
			switch action {
			case "acknowledge":
				result, err = s.Acknowledge(incidentAdminContext(), 1, &note)
			case "unacknowledge":
				result, err = s.Unacknowledge(incidentAdminContext(), 1)
			case "resolve":
				result, err = s.Resolve(incidentAdminContext(), 1, &note)
			case "snooze":
				result, err = s.Snooze(incidentAdminContext(), 1, until)
			}
			require.NoError(t, err)
			require.Equal(t, "canary", result.Source)
			require.Len(t, result.Remediations, 1)
			require.Equal(t, int64(9007199254740993), *result.Remediations[0].WorkflowRunID)
			require.Len(t, q.mutations, 1)
			require.Equal(t, action, q.mutations[0].Action)
			require.Equal(t, "operator", q.mutations[0].Actor)
			require.Len(t, q.audits, 1)
			require.Equal(t, "admin.incident."+action, q.audits[0].EventType)
			require.Equal(t, int64(7), q.audits[0].ActorID.Int64)
			require.Equal(t, int64(1), q.audits[0].TargetID.Int64)
			if action == "resolve" || action == "acknowledge" {
				var metadata map[string]any
				require.NoError(t, json.Unmarshal(q.audits[0].Metadata, &metadata))
				require.Equal(t, note, metadata["note"])
			}
			if action == "snooze" {
				require.Equal(t, until, q.mutations[0].Until.Time)
			}
		})
	}
}

func TestAdminIncidentsResolveIdempotent(t *testing.T) {
	now := time.Now().UTC()
	q := &fakeAdminIncidents{row: db.AlertIncident{ID: 1, State: "resolved", ResolvedAt: pgtype.Timestamptz{Time: now, Valid: true}, ResolvedBy: pgtype.Text{String: "first", Valid: true}, ResolutionNote: pgtype.Text{String: "original", Valid: true}}}
	s := NewAdminIncidentsService(q)
	note := "replacement"
	for i := 0; i < 2; i++ {
		result, err := s.Resolve(incidentAdminContext(), 1, &note)
		require.NoError(t, err)
		require.Equal(t, "first", *result.ResolvedBy)
		require.Equal(t, "original", *result.ResolutionNote)
		require.Equal(t, now, *result.ClosedAt)
	}
	require.Empty(t, q.mutations)
	require.Len(t, q.audits, 2)
}

func TestAdminIncidentsFailures(t *testing.T) {
	for _, tc := range []struct {
		name   string
		q      fakeAdminIncidents
		status int
	}{
		{"missing", fakeAdminIncidents{getErr: pgx.ErrNoRows}, 404},
		{"read", fakeAdminIncidents{getErr: requireError()}, 500},
		{"mutation", fakeAdminIncidents{mutateErr: requireError()}, 500},
		{"jobs", fakeAdminIncidents{jobsErr: requireError()}, 500},
		{"audit", fakeAdminIncidents{auditErr: requireError()}, 500},
		{"terminal", fakeAdminIncidents{row: db.AlertIncident{State: "resolved"}}, 409},
		{"failed", fakeAdminIncidents{row: db.AlertIncident{State: "failed"}}, 409},
		{"changed", fakeAdminIncidents{rows: []db.AlertIncident{}}, 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewAdminIncidentsService(&tc.q).Acknowledge(incidentAdminContext(), 1, nil)
			var api *pkgerrors.APIError
			require.ErrorAs(t, err, &api)
			require.Equal(t, tc.status, api.Status)
		})
	}
	q := &fakeAdminIncidents{}
	_, err := NewAdminIncidentsService(q).Resolve(context.Background(), 1, nil)
	require.Error(t, err)
	require.Empty(t, q.mutations)
}
func requireError() error { return pkgerrors.Internal("database failure") }

func TestAdminIncidentsBulkValidation(t *testing.T) {
	now := time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC)
	future := now.Add(time.Hour)
	max := now.Add(7 * 24 * time.Hour)
	tooFar := max.Add(time.Nanosecond)
	past := now.Add(-time.Second)
	policy := "exact policy"
	blank := " "
	for _, tc := range []struct {
		name  string
		in    AdminIncidentBulkInput
		valid bool
	}{
		{"ids", AdminIncidentBulkInput{Action: "acknowledge", IDs: []int64{1, 2}}, true},
		{"policy", AdminIncidentBulkInput{Action: "resolve", Policy: &policy}, true},
		{"snooze", AdminIncidentBulkInput{Action: "snooze", IDs: []int64{1}, Until: &future}, true},
		{"seven days", AdminIncidentBulkInput{Action: "snooze", Policy: &policy, Until: &max}, true},
		{"both", AdminIncidentBulkInput{Action: "resolve", IDs: []int64{1}, Policy: &policy}, false},
		{"neither", AdminIncidentBulkInput{Action: "resolve"}, false},
		{"empty ids", AdminIncidentBulkInput{Action: "resolve", IDs: []int64{}}, false},
		{"empty policy", AdminIncidentBulkInput{Action: "resolve", Policy: &blank}, false},
		{"bad id", AdminIncidentBulkInput{Action: "resolve", IDs: []int64{-1}}, false},
		{"zero id", AdminIncidentBulkInput{Action: "resolve", IDs: []int64{0}}, false},
		{"unknown action", AdminIncidentBulkInput{Action: "other", IDs: []int64{1}}, false},
		{"bulk unacknowledge", AdminIncidentBulkInput{Action: "unacknowledge", IDs: []int64{1}}, false},
		{"missing until", AdminIncidentBulkInput{Action: "snooze", IDs: []int64{1}}, false},
		{"now", AdminIncidentBulkInput{Action: "snooze", IDs: []int64{1}, Until: &now}, false},
		{"past", AdminIncidentBulkInput{Action: "snooze", IDs: []int64{1}, Until: &past}, false},
		{"too far", AdminIncidentBulkInput{Action: "snooze", IDs: []int64{1}, Until: &tooFar}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &fakeAdminIncidents{rows: []db.AlertIncident{{ID: 1}, {ID: 2}}}
			s := NewAdminIncidentsService(q)
			s.now = func() time.Time { return now }
			n, err := s.Bulk(incidentAdminContext(), tc.in)
			if !tc.valid {
				require.Error(t, err)
				require.Empty(t, q.mutations)
				require.Empty(t, q.audits)
				return
			}
			require.NoError(t, err)
			require.Equal(t, int64(2), n)
			require.Equal(t, "admin.incident.bulk_"+tc.in.Action, q.audits[0].EventType)
			if tc.in.Policy != nil {
				require.Equal(t, *tc.in.Policy, q.mutations[0].Policy.String)
			}
		})
	}
	for _, q := range []*fakeAdminIncidents{{mutateErr: requireError()}, {auditErr: requireError()}} {
		n, err := NewAdminIncidentsService(q).Bulk(incidentAdminContext(), AdminIncidentBulkInput{Action: "resolve", IDs: []int64{1}})
		require.Error(t, err)
		require.Zero(t, n)
	}
}

func TestAdminIncidentListLifecycleViews(t *testing.T) {
	for _, state := range []string{"active", "open", "acknowledged", "snoozed", "resolved", "all"} {
		t.Run(state, func(t *testing.T) {
			q := &mockAdminSystemIncidentsQuerier{listIncidentsFn: func(_ context.Context, p AdminSystemIncidentListParams) ([]db.AlertIncident, error) {
				require.Equal(t, state, p.State)
				require.Equal(t, " exact policy ", p.Policy)
				return nil, nil
			}}
			_, err := NewAdminSystemIncidentsService(q).ListIncidents(context.Background(), AdminSystemIncidentListInput{State: state, Policy: " exact policy "})
			require.NoError(t, err)
		})
	}
}
