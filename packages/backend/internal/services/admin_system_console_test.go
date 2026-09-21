package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// fakeAdminSystemConsoleQuerier records the parameters the adapter forwards and
// returns canned generated rows.
type fakeAdminSystemConsoleQuerier struct {
	incidentParams db.ListAlertIncidentsParams
	incidents      []db.AlertIncident
	incidentsErr   error

	jobIDs  []int64
	jobs    []db.ListAlertRemediationJobsForIncidentsRow
	jobsErr error

	landingDepth int64
	landingErr   error
}

func (f *fakeAdminSystemConsoleQuerier) ListAlertIncidents(_ context.Context, arg db.ListAlertIncidentsParams) ([]db.AlertIncident, error) {
	f.incidentParams = arg
	return f.incidents, f.incidentsErr
}

func (f *fakeAdminSystemConsoleQuerier) ListAlertRemediationJobsForIncidents(_ context.Context, incidentIDs []int64) ([]db.ListAlertRemediationJobsForIncidentsRow, error) {
	f.jobIDs = incidentIDs
	return f.jobs, f.jobsErr
}

func (f *fakeAdminSystemConsoleQuerier) GetLandingQueueDepth(context.Context) (int64, error) {
	return f.landingDepth, f.landingErr
}

func TestAdminSystemConsoleStoreListAlertIncidents(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		params    AdminSystemIncidentListParams
		wantState string
	}{
		{
			name:      "active view",
			params:    AdminSystemIncidentListParams{State: "active", PageLimit: 25},
			wantState: "active",
		},
		{
			name:      "all view",
			params:    AdminSystemIncidentListParams{State: "all", Policy: "exact policy", PageLimit: 200},
			wantState: "all",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			querier := &fakeAdminSystemConsoleQuerier{
				incidents: []db.AlertIncident{{ID: 7, PolicyName: "HighErrorRate", State: "open"}},
			}
			store := NewAdminSystemConsoleStore(querier)

			incidents, err := store.ListAlertIncidents(context.Background(), tt.params)
			require.NoError(t, err)
			require.Len(t, incidents, 1)
			assert.Equal(t, int64(7), incidents[0].ID)
			assert.Equal(t, tt.wantState, querier.incidentParams.StateFilter)
			assert.Equal(t, tt.params.PageLimit, querier.incidentParams.PageLimit)
			assert.Equal(t, tt.params.Policy, querier.incidentParams.Policy.String)
			assert.Equal(t, tt.params.Policy != "", querier.incidentParams.Policy.Valid)
		})
	}
}

func TestAdminSystemConsoleStoreListAlertIncidentsError(t *testing.T) {
	t.Parallel()

	store := NewAdminSystemConsoleStore(&fakeAdminSystemConsoleQuerier{incidentsErr: errors.New("query failed")})

	_, err := store.ListAlertIncidents(context.Background(), AdminSystemIncidentListParams{PageLimit: 10})
	assert.Error(t, err)
}

func TestAdminSystemConsoleStoreListAlertRemediationJobsForIncidents(t *testing.T) {
	t.Parallel()

	created := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	updated := created.Add(time.Minute)
	querier := &fakeAdminSystemConsoleQuerier{
		jobs: []db.ListAlertRemediationJobsForIncidentsRow{
			{
				ID:            11,
				IncidentID:    7,
				Status:        "succeeded",
				Attempts:      2,
				Error:         "transient failure",
				CreatedAt:     created,
				UpdatedAt:     updated,
				WorkflowRunID: pgtype.Int8{Int64: 4242, Valid: true},
			},
			{
				ID:         12,
				IncidentID: 7,
				Status:     "pending",
				CreatedAt:  created,
				UpdatedAt:  updated,
			},
		},
	}
	store := NewAdminSystemConsoleStore(querier)

	jobs, err := store.ListAlertRemediationJobsForIncidents(context.Background(), []int64{7})
	require.NoError(t, err)
	require.Len(t, jobs, 2)
	assert.Equal(t, []int64{7}, querier.jobIDs)
	assert.Equal(t, AdminSystemRemediationJobRow{
		ID:            11,
		IncidentID:    7,
		Status:        "succeeded",
		Attempts:      2,
		WorkflowRunID: pgtype.Int8{Int64: 4242, Valid: true},
		CreatedAt:     created,
		UpdatedAt:     updated,
	}, jobs[0])
	assert.False(t, jobs[1].WorkflowRunID.Valid)
}

func TestAdminSystemConsoleStoreListAlertRemediationJobsForIncidentsError(t *testing.T) {
	t.Parallel()

	store := NewAdminSystemConsoleStore(&fakeAdminSystemConsoleQuerier{jobsErr: errors.New("query failed")})

	_, err := store.ListAlertRemediationJobsForIncidents(context.Background(), []int64{1})
	assert.Error(t, err)
}

func TestAdminSystemConsoleStoreCountQueuedLandingTasks(t *testing.T) {
	t.Parallel()

	store := NewAdminSystemConsoleStore(&fakeAdminSystemConsoleQuerier{landingDepth: 3})

	depth, err := store.CountQueuedLandingTasks(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int64(3), depth)

	failing := NewAdminSystemConsoleStore(&fakeAdminSystemConsoleQuerier{landingErr: errors.New("count failed")})
	_, err = failing.CountQueuedLandingTasks(context.Background())
	assert.Error(t, err)
}
