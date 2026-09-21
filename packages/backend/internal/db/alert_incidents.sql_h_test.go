package db

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAlertIncidentsSQL_H_IncidentAndRemediationRoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)

	incident := alertIncidentsSQLHCreateIncident(t, q, "incident-h-"+randSlug(t), "policy-h", "condition-a")
	got, err := q.GetAlertIncident(ctx, incident.ID)
	require.NoError(t, err)
	assert.Equal(t, incident.IncidentID, got.IncidentID)
	byIncidentID, err := q.GetAlertIncidentByIncidentID(ctx, incident.IncidentID)
	require.NoError(t, err)
	assert.Equal(t, incident.ID, byIncidentID.ID)

	other := alertIncidentsSQLHCreateIncident(t, q, "incident-h-"+randSlug(t), "policy-h", "condition-b")
	active, err := q.CountActiveAlertIncidentsForPolicy(ctx, CountActiveAlertIncidentsForPolicyParams{PolicyName: "policy-h", ID: incident.ID})
	require.NoError(t, err)
	assert.Equal(t, int64(1), active)

	require.NoError(t, q.UpdateAlertIncidentState(ctx, UpdateAlertIncidentStateParams{ID: other.ID, State: "resolved"}))
	active, err = q.CountActiveAlertIncidentsForPolicy(ctx, CountActiveAlertIncidentsForPolicyParams{PolicyName: "policy-h", ID: incident.ID})
	require.NoError(t, err)
	assert.Zero(t, active)

	job, err := q.CreateAlertRemediationJob(ctx, incident.ID)
	require.NoError(t, err)
	assert.Equal(t, incident.ID, job.IncidentID)
	jobs, err := q.CountAlertRemediationJobsForPolicySince(ctx, CountAlertRemediationJobsForPolicySinceParams{
		PolicyName: "policy-h",
		CreatedAt:  time.Now().Add(-time.Hour),
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), jobs)
	jobs, err = q.CountAlertRemediationJobsForPolicySince(ctx, CountAlertRemediationJobsForPolicySinceParams{
		PolicyName: "policy-h",
		CreatedAt:  time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	assert.Zero(t, jobs)

	require.NoError(t, q.RecordAlertIncidentRemediationOutcome(ctx, RecordAlertIncidentRemediationOutcomeParams{
		ID:               incident.ID,
		State:            "resolved",
		RemediationPrUrl: "https://github.example/report/1",
	}))
	remediated, err := q.GetAlertIncident(ctx, incident.ID)
	require.NoError(t, err)
	assert.Equal(t, "resolved", remediated.State)
	assert.Equal(t, int32(1), remediated.Attempts)
	assert.Equal(t, "https://github.example/report/1", remediated.RemediationPrUrl)
	assert.True(t, remediated.ResolvedAt.Valid)

	require.NoError(t, q.ResolveAlertIncidentByIncidentID(ctx, incident.IncidentID))
	resolved, err := q.GetAlertIncident(ctx, incident.ID)
	require.NoError(t, err)
	assert.Equal(t, "resolved", resolved.State)
	assert.True(t, resolved.ResolvedAt.Valid)
	require.NoError(t, q.ResolveAlertIncidentByIncidentID(ctx, incident.IncidentID))

	noRows, err := q.CreateAlertIncident(ctx, CreateAlertIncidentParams{
		IncidentID: incident.IncidentID, PolicyName: "policy-h", ConditionName: "duplicate",
		Summary: "duplicate", IncidentUrl: "https://incident.example/duplicate", Runbook: "runbook", Workflow: "workflow",
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	assert.Zero(t, noRows.ID)

	require.NoError(t, q.RecordAlertIncidentRemediationOutcome(ctx, RecordAlertIncidentRemediationOutcomeParams{ID: 999999, State: "failed"}))
	require.NoError(t, q.UpdateAlertIncidentState(ctx, UpdateAlertIncidentStateParams{ID: 999999, State: "failed"}))
	require.NoError(t, q.ResolveAlertIncidentByIncidentID(ctx, "missing-incident-h"))

	_, err = q.GetAlertIncident(ctx, 999999)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	tombstone, err := q.GetAlertIncidentByIncidentID(ctx, "missing-incident-h")
	require.NoError(t, err)
	assert.Equal(t, "resolved", tombstone.State)
	_, err = q.CreateAlertIncident(ctx, CreateAlertIncidentParams{
		IncidentID: "missing-incident-h", PolicyName: "policy-delayed-open", ConditionName: "condition",
		Summary: "delayed open", IncidentUrl: "https://incident.example/delayed", Runbook: "runbook", Workflow: "workflow",
	})
	require.ErrorIs(t, err, pgx.ErrNoRows, "a delayed open delivery must not resurrect a close-first tombstone")

	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateAlertRemediationJob(ctx, 999999)
		return err
	})
	invalidStateTarget := alertIncidentsSQLHCreateIncident(
		t,
		q,
		"incident-invalid-state-"+randSlug(t),
		"policy-invalid-state",
		"condition",
	)
	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		return spQ.UpdateAlertIncidentState(ctx, UpdateAlertIncidentStateParams{ID: invalidStateTarget.ID, State: "not-a-state"})
	})
}

func TestAlertIncidentsSQL_H_QueryRowErrorBranches(t *testing.T) {
	sentinel := errors.New("alert incidents h row failed")
	q := New(alertIncidentsSQLHDB{row: alertIncidentsSQLHRow{err: sentinel}})

	_, err := q.CountActiveAlertIncidentsForPolicy(context.Background(), CountActiveAlertIncidentsForPolicyParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.CountAlertRemediationJobsForPolicySince(context.Background(), CountAlertRemediationJobsForPolicySinceParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.CreateAlertIncident(context.Background(), CreateAlertIncidentParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.CreateAlertRemediationJob(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
	_, err = q.GetAlertIncident(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
	_, err = q.GetAlertIncidentByIncidentID(context.Background(), "incident")
	require.ErrorIs(t, err, sentinel)
}

func TestAlertIncidentsSQL_H_ExecErrorBranches(t *testing.T) {
	sentinel := errors.New("alert incidents h exec failed")
	q := New(alertIncidentsSQLHDB{execErr: sentinel})

	require.ErrorIs(t, q.RecordAlertIncidentRemediationOutcome(context.Background(), RecordAlertIncidentRemediationOutcomeParams{ID: 1, State: "failed"}), sentinel)
	require.ErrorIs(t, q.ResolveAlertIncidentByIncidentID(context.Background(), "incident"), sentinel)
	require.ErrorIs(t, q.UpdateAlertIncidentState(context.Background(), UpdateAlertIncidentStateParams{ID: 1, State: "failed"}), sentinel)
}

func alertIncidentsSQLHCreateIncident(t *testing.T, q *Queries, incidentID, policyName, conditionName string) AlertIncident {
	t.Helper()
	incident, err := q.CreateAlertIncident(context.Background(), CreateAlertIncidentParams{
		IncidentID:    incidentID,
		PolicyName:    policyName,
		ConditionName: conditionName,
		Summary:       "summary " + conditionName,
		IncidentUrl:   "https://incident.example/" + incidentID,
		Runbook:       "runbook",
		Workflow:      "workflow",
	})
	require.NoError(t, err)
	return AlertIncident(incident)
}

type alertIncidentsSQLHDB struct {
	execErr error
	row     pgx.Row
}

func (db alertIncidentsSQLHDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, db.execErr
}

func (db alertIncidentsSQLHDB) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	return &alertIncidentsSQLHRows{}, nil
}

func (db alertIncidentsSQLHDB) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	if db.row != nil {
		return db.row
	}
	return alertIncidentsSQLHRow{err: errors.New("alert incidents h row failed")}
}

type alertIncidentsSQLHRow struct {
	err error
}

func (r alertIncidentsSQLHRow) Scan(...any) error {
	return r.err
}

type alertIncidentsSQLHRows struct{}

func (r *alertIncidentsSQLHRows) Close() {}

func (r *alertIncidentsSQLHRows) Err() error {
	return nil
}

func (r *alertIncidentsSQLHRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r *alertIncidentsSQLHRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}

func (r *alertIncidentsSQLHRows) Next() bool {
	return false
}

func (r *alertIncidentsSQLHRows) Scan(...any) error {
	return errors.New("alert incidents h scan unexpectedly succeeded")
}

func (r *alertIncidentsSQLHRows) Values() ([]any, error) {
	return nil, nil
}

func (r *alertIncidentsSQLHRows) RawValues() [][]byte {
	return nil
}

func (r *alertIncidentsSQLHRows) Conn() *pgx.Conn {
	return nil
}
