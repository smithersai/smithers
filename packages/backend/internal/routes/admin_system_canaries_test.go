package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockAdminCanaryLister struct {
	rows []db.CanaryResult
	err  error
}

func (m *mockAdminCanaryLister) ListCanaryResults(_ context.Context) ([]db.CanaryResult, error) {
	if m.err != nil {
		return nil, m.err
	}
	return m.rows, nil
}

var adminCanaryTestNow = time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)

func adminCanaryTestHandler(store AdminCanaryLister) *AdminSystemCanariesHandler {
	return &AdminSystemCanariesHandler{
		Store: store,
		Clock: func() time.Time { return adminCanaryTestNow },
	}
}

func adminCanaryTestRequest() *http.Request {
	return httptest.NewRequest(http.MethodGet, "/api/admin/system/canaries", nil)
}

func TestAdminSystemCanariesHandler_SystemCanaries(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name     string
		store    *mockAdminCanaryLister
		wantCode int
		assert   func(t *testing.T, body adminSystemCanariesResponse)
	}{
		{
			name: "maps rows and sorts by name",
			store: &mockAdminCanaryLister{rows: []db.CanaryResult{
				{
					Suite:           "workflow",
					TestName:        "auth",
					Status:          "failure",
					DurationSeconds: 2.5,
					ErrorMessage:    "login failed",
					ReportedAt:      adminCanaryTestNow.Add(-time.Minute),
				},
				{
					Suite:           "playwright",
					TestName:        "ui-health",
					Status:          "success",
					DurationSeconds: 1.25,
					ReportedAt:      adminCanaryTestNow.Add(-30 * time.Second),
				},
				{
					Suite:      "playwright",
					TestName:   "ui-auth-flow",
					Status:     "skipped",
					ReportedAt: adminCanaryTestNow.Add(-2 * time.Minute),
				},
			}},
			wantCode: http.StatusOK,
			assert: func(t *testing.T, body adminSystemCanariesResponse) {
				require.Len(t, body.Canaries, 3)

				assert.Equal(t, []string{
					"playwright/ui-auth-flow",
					"playwright/ui-health",
					"workflow/auth",
				}, []string{body.Canaries[0].Name, body.Canaries[1].Name, body.Canaries[2].Name})

				// Unknown stored status is reported as unknown, not guessed.
				assert.Equal(t, "unknown", body.Canaries[0].Status)
				assert.Nil(t, body.Canaries[0].LatencyMS, "zero duration reports a null latency")
				assert.Empty(t, body.Canaries[0].Detail)

				assert.Equal(t, "passing", body.Canaries[1].Status)
				require.NotNil(t, body.Canaries[1].LatencyMS)
				assert.InDelta(t, 1250, *body.Canaries[1].LatencyMS, 0.001)
				assert.Equal(t, adminCanaryTestNow.Add(-30*time.Second).Format(time.RFC3339), body.Canaries[1].LastRunAt)
				assert.False(t, body.Canaries[1].Stale)

				assert.Equal(t, "failing", body.Canaries[2].Status)
				assert.Equal(t, "login failed", body.Canaries[2].Detail)
				require.NotNil(t, body.Canaries[2].LatencyMS)
				assert.InDelta(t, 2500, *body.Canaries[2].LatencyMS, 0.001)
			},
		},
		{
			name:     "empty store returns an empty list",
			store:    &mockAdminCanaryLister{rows: []db.CanaryResult{}},
			wantCode: http.StatusOK,
			assert: func(t *testing.T, body adminSystemCanariesResponse) {
				assert.Empty(t, body.Canaries)
			},
		},
		{
			name: "staleness boundary follows the backend cadence",
			store: &mockAdminCanaryLister{rows: []db.CanaryResult{
				{
					Suite:      "workflow",
					TestName:   "a-fresh",
					Status:     "success",
					ReportedAt: adminCanaryTestNow.Add(-services.CanaryFreshnessWindow("workflow", "auth") + time.Second),
				},
				{
					Suite:      "workflow",
					TestName:   "b-boundary",
					Status:     "success",
					ReportedAt: adminCanaryTestNow.Add(-services.CanaryFreshnessWindow("workflow", "auth")),
				},
				{
					Suite:      "workflow",
					TestName:   "c-stale",
					Status:     "success",
					ReportedAt: adminCanaryTestNow.Add(-services.CanaryFreshnessWindow("workflow", "auth") - time.Second),
				},
			}},
			wantCode: http.StatusOK,
			assert: func(t *testing.T, body adminSystemCanariesResponse) {
				require.Len(t, body.Canaries, 3)
				assert.False(t, body.Canaries[0].Stale, "one second inside the window is fresh")
				assert.False(t, body.Canaries[1].Stale, "exactly at the freshness deadline is not yet stale")
				assert.True(t, body.Canaries[2].Stale, "one second past the window is stale")
				// Staleness is independent of pass/fail status.
				assert.Equal(t, "passing", body.Canaries[2].Status)
			},
		},
		{
			name:     "store error returns 500",
			store:    &mockAdminCanaryLister{err: errors.New("connection refused")},
			wantCode: http.StatusInternalServerError,
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			rec := httptest.NewRecorder()
			adminCanaryTestHandler(tc.store).SystemCanaries(rec, adminCanaryTestRequest())

			require.Equal(t, tc.wantCode, rec.Code)
			if tc.assert == nil {
				return
			}

			var body adminSystemCanariesResponse
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			tc.assert(t, body)
		})
	}
}

func TestAdminSystemCanariesHandler_SystemCanaries_EmptyListSerializesAsArray(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	adminCanaryTestHandler(&mockAdminCanaryLister{}).SystemCanaries(rec, adminCanaryTestRequest())

	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"canaries":[]}`, rec.Body.String())
}

func TestAdminSystemCanariesHandler_SystemCanaries_MissingStoreReturns500(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	(&AdminSystemCanariesHandler{}).SystemCanaries(rec, adminCanaryTestRequest())

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestAdminSystemCanariesHandler_SystemCanaries_DefaultClockUsesNow(t *testing.T) {
	t.Parallel()

	handler := &AdminSystemCanariesHandler{Store: &mockAdminCanaryLister{rows: []db.CanaryResult{
		{Suite: "workflow", TestName: "fresh", Status: "success", ReportedAt: time.Now().UTC()},
		{Suite: "workflow", TestName: "old", Status: "success", ReportedAt: time.Now().UTC().Add(-time.Hour)},
	}}}

	rec := httptest.NewRecorder()
	handler.SystemCanaries(rec, adminCanaryTestRequest())

	require.Equal(t, http.StatusOK, rec.Code)

	var body adminSystemCanariesResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Canaries, 2)
	assert.False(t, body.Canaries[0].Stale)
	assert.True(t, body.Canaries[1].Stale)
}

func TestAdminCanaryName_UnqualifiedWhenSuiteMissing(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "ui-health", adminCanaryName(db.CanaryResult{TestName: " ui-health "}))
	assert.Equal(t, "playwright/ui-health", adminCanaryName(db.CanaryResult{Suite: "playwright", TestName: "ui-health"}))
}

func TestAdminCanaryStatus_Mapping(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "passing", services.ClassifyCanaryStatus("SUCCESS"))
	assert.Equal(t, "failing", services.ClassifyCanaryStatus(" failure "))
	assert.Equal(t, "unknown", services.ClassifyCanaryStatus(""))
}
