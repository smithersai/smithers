package clusterservices

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestAlertIncident_Z_ErrorBranchesAndConstructorClock(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	base := MonitoringAlertIncident{
		IncidentID:    "incident-z",
		PolicyName:    "Smithers High Error Rate - prod",
		ConditionName: "errors",
		State:         "open",
	}

	svc := NewAlertIncidentService(&fakeAlertIncidentQuerier{}, testAlertRegistry(t))
	require.NotNil(t, svc.now())

	for _, tc := range []struct {
		name string
		q    AlertIncidentQuerier
	}{
		{
			name: "count active error",
			q: alertIncidentZQuerier{
				fakeAlertIncidentQuerier: &fakeAlertIncidentQuerier{},
				countActiveErr:           errors.New("count active failed"),
			},
		},
		{
			name: "count attempts error",
			q: alertIncidentZQuerier{
				fakeAlertIncidentQuerier: &fakeAlertIncidentQuerier{},
				countAttemptsErr:         errors.New("count attempts failed"),
			},
		},
		{
			name: "enqueue error",
			q: alertIncidentZQuerier{
				fakeAlertIncidentQuerier: &fakeAlertIncidentQuerier{},
				createJobErr:             errors.New("enqueue failed"),
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := NewAlertIncidentService(tc.q, testAlertRegistry(t))
			err := svc.HandleAlertIncident(ctx, base)
			require.Error(t, err)
		})
	}

	for _, tc := range []struct {
		name string
		q    AlertIncidentQuerier
		want string
	}{
		{
			name: "load internal error",
			q: alertIncidentZQuerier{
				fakeAlertIncidentQuerier: &fakeAlertIncidentQuerier{},
				getIncidentErr:           errors.New("load failed"),
			},
			want: "load alert incident",
		},
		{
			name: "record error",
			q: alertIncidentZQuerier{
				fakeAlertIncidentQuerier: &fakeAlertIncidentQuerier{incidentByID: map[string]db.AlertIncident{
					"incident-z": {ID: 9, IncidentID: "incident-z"},
				}},
				recordOutcomeErr: errors.New("record failed"),
			},
			want: "record remediation outcome",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := NewAlertIncidentService(tc.q, testAlertRegistry(t))
			err := svc.RecordRemediationOutcome(ctx, AlertRemediationOutcome{IncidentID: "incident-z", State: "failed"})
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.want)
		})
	}

	require.NoError(t, (*AlertIncidentService)(nil).HandleAlertIncident(ctx, base))
	require.NoError(t, (*AlertIncidentService)(nil).RecordRemediationOutcome(ctx, AlertRemediationOutcome{State: "failed"}))
}

type alertIncidentZQuerier struct {
	*fakeAlertIncidentQuerier
	countActiveErr   error
	countAttemptsErr error
	createJobErr     error
	getIncidentErr   error
	recordOutcomeErr error
}

func (q alertIncidentZQuerier) CountActiveAlertIncidentsForPolicy(context.Context, db.CountActiveAlertIncidentsForPolicyParams) (int64, error) {
	if q.countActiveErr != nil {
		return 0, q.countActiveErr
	}
	return q.fakeAlertIncidentQuerier.CountActiveAlertIncidentsForPolicy(context.Background(), db.CountActiveAlertIncidentsForPolicyParams{})
}

func (q alertIncidentZQuerier) CountAlertRemediationJobsForPolicySince(context.Context, db.CountAlertRemediationJobsForPolicySinceParams) (int64, error) {
	if q.countAttemptsErr != nil {
		return 0, q.countAttemptsErr
	}
	return q.fakeAlertIncidentQuerier.CountAlertRemediationJobsForPolicySince(context.Background(), db.CountAlertRemediationJobsForPolicySinceParams{})
}

func (q alertIncidentZQuerier) CreateAlertRemediationJob(context.Context, int64) (db.AlertRemediationJob, error) {
	if q.createJobErr != nil {
		return db.AlertRemediationJob{}, q.createJobErr
	}
	return q.fakeAlertIncidentQuerier.CreateAlertRemediationJob(context.Background(), 1)
}

func (q alertIncidentZQuerier) GetAlertIncidentByIncidentID(ctx context.Context, incidentID string) (db.AlertIncident, error) {
	if q.getIncidentErr != nil {
		return db.AlertIncident{}, q.getIncidentErr
	}
	return q.fakeAlertIncidentQuerier.GetAlertIncidentByIncidentID(ctx, incidentID)
}

func (q alertIncidentZQuerier) RecordAlertIncidentRemediationOutcomeGuarded(ctx context.Context, arg db.RecordAlertIncidentRemediationOutcomeGuardedParams) (int64, error) {
	if q.recordOutcomeErr != nil {
		return 0, q.recordOutcomeErr
	}
	return q.fakeAlertIncidentQuerier.RecordAlertIncidentRemediationOutcomeGuarded(ctx, arg)
}

var _ AlertIncidentQuerier = alertIncidentZQuerier{}

func TestAlertIncident_Z_ClosedResolveError(t *testing.T) {
	t.Parallel()

	svc := NewAlertIncidentService(&alertIncidentZResolveQuerier{fakeAlertIncidentQuerier: &fakeAlertIncidentQuerier{}}, testAlertRegistry(t))
	err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{
		IncidentID: "incident-closed",
		State:      "closed",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "resolve alert incident")
}

type alertIncidentZResolveQuerier struct {
	*fakeAlertIncidentQuerier
}

func (alertIncidentZResolveQuerier) ResolveAlertIncidentByIncidentID(context.Context, string) error {
	return errors.New("resolve failed")
}

var _ AlertIncidentQuerier = (*alertIncidentZResolveQuerier)(nil)

func TestAlertIncident_Z_RecordRemediationNotFound(t *testing.T) {
	t.Parallel()

	svc := NewAlertIncidentService(alertIncidentZQuerier{
		fakeAlertIncidentQuerier: &fakeAlertIncidentQuerier{incidentByID: map[string]db.AlertIncident{}},
	}, testAlertRegistry(t))
	err := svc.RecordRemediationOutcome(context.Background(), AlertRemediationOutcome{IncidentID: "missing", State: "failed"})
	assert.Equal(t, 404, apiStatus(t, err))
}

func TestAlertIncident_Z_DuplicateCreateNonNoRowsError(t *testing.T) {
	t.Parallel()

	svc := NewAlertIncidentService(&fakeAlertIncidentQuerier{createErr: errors.New("insert failed")}, testAlertRegistry(t))
	err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{
		IncidentID: "incident-insert",
		PolicyName: "Some Policy",
		State:      "open",
	})
	require.Error(t, err)
	assert.NotErrorIs(t, err, pgx.ErrNoRows)
}
