package clusterservices

import (
	"context"
	stderrors "errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockAdminSystemIncidentsQuerier struct {
	listIncidentsFn func(ctx context.Context, arg AdminSystemIncidentListParams) ([]clusterdb.AlertIncident, error)
	listJobsFn      func(ctx context.Context, incidentIDs []int64) ([]AdminSystemRemediationJobRow, error)
}

func (m *mockAdminSystemIncidentsQuerier) ListAlertIncidents(ctx context.Context, arg AdminSystemIncidentListParams) ([]clusterdb.AlertIncident, error) {
	if m.listIncidentsFn != nil {
		return m.listIncidentsFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockAdminSystemIncidentsQuerier) ListAlertRemediationJobsForIncidents(ctx context.Context, incidentIDs []int64) ([]AdminSystemRemediationJobRow, error) {
	if m.listJobsFn != nil {
		return m.listJobsFn(ctx, incidentIDs)
	}
	return nil, nil
}

func makeAdminSystemIncidentRow(id int64, policy, state string, createdAt time.Time, resolvedAt *time.Time) clusterdb.AlertIncident {
	row := clusterdb.AlertIncident{
		ID:         id,
		IncidentID: "gcp-" + policy,
		PolicyName: policy,
		State:      state,
		Summary:    policy + " fired",
		CreatedAt:  createdAt,
		UpdatedAt:  createdAt,
	}
	if resolvedAt != nil {
		row.ResolvedAt = pgtype.Timestamptz{Time: *resolvedAt, Valid: true}
	}
	return row
}

func makeAdminSystemJobRow(id, incidentID int64, status string, attempts int32, runID *int64, createdAt time.Time) AdminSystemRemediationJobRow {
	row := AdminSystemRemediationJobRow{
		ID:         id,
		IncidentID: incidentID,
		Status:     status,
		Attempts:   attempts,
		CreatedAt:  createdAt,
		UpdatedAt:  createdAt.Add(time.Minute),
	}
	if runID != nil {
		row.WorkflowRunID = pgtype.Int8{Int64: *runID, Valid: true}
	}
	return row
}

func TestAdminSystemIncidentsService_ListIncidents(t *testing.T) {
	t.Parallel()

	base := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)

	t.Run("attaches remediations to their incidents newest first", func(t *testing.T) {
		t.Parallel()

		runID := int64(4242)
		var gotIDs []int64
		q := &mockAdminSystemIncidentsQuerier{
			listIncidentsFn: func(_ context.Context, arg AdminSystemIncidentListParams) ([]clusterdb.AlertIncident, error) {
				assert.Equal(t, "active", arg.State)
				assert.Equal(t, int32(50), arg.PageLimit)
				return []clusterdb.AlertIncident{
					makeAdminSystemIncidentRow(1, "api-5xx", "open", base, nil),
					makeAdminSystemIncidentRow(2, "queue-depth", "remediating", base.Add(time.Hour), nil),
				}, nil
			},
			listJobsFn: func(_ context.Context, incidentIDs []int64) ([]AdminSystemRemediationJobRow, error) {
				gotIDs = incidentIDs
				return []AdminSystemRemediationJobRow{
					makeAdminSystemJobRow(10, 2, "processing", 2, &runID, base.Add(90*time.Minute)),
					makeAdminSystemJobRow(11, 2, "failed", 1, nil, base.Add(80*time.Minute)),
				}, nil
			},
		}

		out, err := NewAdminSystemIncidentsService(q).ListIncidents(context.Background(), AdminSystemIncidentListInput{})
		require.NoError(t, err)
		require.Len(t, out, 2)
		assert.Equal(t, []int64{1, 2}, gotIDs)

		// Newest incident first.
		assert.Equal(t, int64(2), out[0].ID)
		assert.Equal(t, "queue-depth", out[0].Policy)
		assert.Equal(t, "remediating", out[0].State)
		assert.Equal(t, base.Add(time.Hour), out[0].OpenedAt)
		assert.Nil(t, out[0].ClosedAt)
		require.Len(t, out[0].Remediations, 2)
		// Newest attempt first.
		assert.Equal(t, int64(10), out[0].Remediations[0].ID)
		assert.Equal(t, "processing", out[0].Remediations[0].State)
		assert.Equal(t, int32(2), out[0].Remediations[0].Attempts)
		require.NotNil(t, out[0].Remediations[0].WorkflowRunID)
		assert.Equal(t, int64(4242), *out[0].Remediations[0].WorkflowRunID)
		assert.Nil(t, out[0].Remediations[1].WorkflowRunID)

		assert.Equal(t, int64(1), out[1].ID)
		assert.Empty(t, out[1].Remediations)
		assert.NotNil(t, out[1].Remediations, "remediations must serialize as [] not null")
	})

	t.Run("maps resolved_at to closed_at", func(t *testing.T) {
		t.Parallel()

		resolved := base.Add(2 * time.Hour)
		q := &mockAdminSystemIncidentsQuerier{
			listIncidentsFn: func(_ context.Context, _ AdminSystemIncidentListParams) ([]clusterdb.AlertIncident, error) {
				return []clusterdb.AlertIncident{
					makeAdminSystemIncidentRow(7, "disk-full", "resolved", base, &resolved),
				}, nil
			},
		}

		out, err := NewAdminSystemIncidentsService(q).ListIncidents(context.Background(), AdminSystemIncidentListInput{State: AdminSystemIncidentStateAll})
		require.NoError(t, err)
		require.Len(t, out, 1)
		require.NotNil(t, out[0].ClosedAt)
		assert.Equal(t, resolved, *out[0].ClosedAt)
	})

	t.Run("state all clears the active-only filter", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminSystemIncidentsQuerier{
			listIncidentsFn: func(_ context.Context, arg AdminSystemIncidentListParams) ([]clusterdb.AlertIncident, error) {
				assert.Equal(t, "all", arg.State)
				return nil, nil
			},
		}

		out, err := NewAdminSystemIncidentsService(q).ListIncidents(context.Background(), AdminSystemIncidentListInput{State: AdminSystemIncidentStateAll})
		require.NoError(t, err)
		assert.Empty(t, out)
		assert.NotNil(t, out)
	})

	t.Run("skips the jobs query when no incidents match", func(t *testing.T) {
		t.Parallel()

		jobsCalled := false
		q := &mockAdminSystemIncidentsQuerier{
			listIncidentsFn: func(_ context.Context, _ AdminSystemIncidentListParams) ([]clusterdb.AlertIncident, error) {
				return []clusterdb.AlertIncident{}, nil
			},
			listJobsFn: func(_ context.Context, _ []int64) ([]AdminSystemRemediationJobRow, error) {
				jobsCalled = true
				return nil, nil
			},
		}

		out, err := NewAdminSystemIncidentsService(q).ListIncidents(context.Background(), AdminSystemIncidentListInput{})
		require.NoError(t, err)
		assert.Empty(t, out)
		assert.False(t, jobsCalled)
	})

	t.Run("drops jobs whose incident is not in the page", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminSystemIncidentsQuerier{
			listIncidentsFn: func(_ context.Context, _ AdminSystemIncidentListParams) ([]clusterdb.AlertIncident, error) {
				return []clusterdb.AlertIncident{makeAdminSystemIncidentRow(1, "api-5xx", "open", base, nil)}, nil
			},
			listJobsFn: func(_ context.Context, _ []int64) ([]AdminSystemRemediationJobRow, error) {
				return []AdminSystemRemediationJobRow{
					makeAdminSystemJobRow(10, 99, "done", 1, nil, base),
				}, nil
			},
		}

		out, err := NewAdminSystemIncidentsService(q).ListIncidents(context.Background(), AdminSystemIncidentListInput{})
		require.NoError(t, err)
		require.Len(t, out, 1)
		assert.Empty(t, out[0].Remediations)
	})

	t.Run("honors an explicit limit", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminSystemIncidentsQuerier{
			listIncidentsFn: func(_ context.Context, arg AdminSystemIncidentListParams) ([]clusterdb.AlertIncident, error) {
				assert.Equal(t, int32(200), arg.PageLimit)
				return nil, nil
			},
		}

		_, err := NewAdminSystemIncidentsService(q).ListIncidents(context.Background(), AdminSystemIncidentListInput{Limit: 200})
		require.NoError(t, err)
	})

	t.Run("rejects invalid input", func(t *testing.T) {
		t.Parallel()

		cases := []struct {
			name  string
			input AdminSystemIncidentListInput
		}{
			{name: "unknown state", input: AdminSystemIncidentListInput{State: "closed"}},
			{name: "negative limit", input: AdminSystemIncidentListInput{Limit: -1}},
			{name: "limit above max", input: AdminSystemIncidentListInput{Limit: 201}},
		}

		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				t.Parallel()

				_, err := NewAdminSystemIncidentsService(&mockAdminSystemIncidentsQuerier{}).ListIncidents(context.Background(), tc.input)
				require.Error(t, err)
				var apiErr *pkgerrors.APIError
				require.True(t, stderrors.As(err, &apiErr))
				assert.Equal(t, http.StatusBadRequest, apiErr.Status)
			})
		}
	})

	t.Run("returns 500 when the incidents query fails", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminSystemIncidentsQuerier{
			listIncidentsFn: func(_ context.Context, _ AdminSystemIncidentListParams) ([]clusterdb.AlertIncident, error) {
				return nil, stderrors.New("boom")
			},
		}

		_, err := NewAdminSystemIncidentsService(q).ListIncidents(context.Background(), AdminSystemIncidentListInput{})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.True(t, stderrors.As(err, &apiErr))
		assert.Equal(t, http.StatusInternalServerError, apiErr.Status)
		assert.NotContains(t, apiErr.Message, "boom")
	})

	t.Run("returns 500 when the remediation jobs query fails", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminSystemIncidentsQuerier{
			listIncidentsFn: func(_ context.Context, _ AdminSystemIncidentListParams) ([]clusterdb.AlertIncident, error) {
				return []clusterdb.AlertIncident{makeAdminSystemIncidentRow(1, "api-5xx", "open", base, nil)}, nil
			},
			listJobsFn: func(_ context.Context, _ []int64) ([]AdminSystemRemediationJobRow, error) {
				return nil, stderrors.New("boom")
			},
		}

		_, err := NewAdminSystemIncidentsService(q).ListIncidents(context.Background(), AdminSystemIncidentListInput{})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.True(t, stderrors.As(err, &apiErr))
		assert.Equal(t, http.StatusInternalServerError, apiErr.Status)
	})
}
