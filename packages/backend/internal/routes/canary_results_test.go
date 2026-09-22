package routes_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

type stubCanaryResultStore struct {
	args []clusterdb.UpsertCanaryResultParams
	err  error
}

func (s *stubCanaryResultStore) UpsertCanaryResult(_ context.Context, arg clusterdb.UpsertCanaryResultParams) (clusterdb.CanaryResult, error) {
	s.args = append(s.args, arg)
	if s.err != nil {
		return clusterdb.CanaryResult{}, s.err
	}
	return clusterdb.CanaryResult{
		Suite:      arg.Suite,
		TestName:   arg.TestName,
		Status:     arg.Status,
		ReportedAt: arg.ReportedAt,
	}, nil
}

func TestCanaryReportHandler_PostResults_AcceptsValidPayload(t *testing.T) {
	t.Parallel()

	reportedAt := time.Unix(1_710_000_000, 0).UTC()
	store := &stubCanaryResultStore{}
	handler := &routes.CanaryReportHandler{
		Store: store,
		Clock: func() time.Time { return reportedAt },
	}

	req := httptest.NewRequest(http.MethodPost, "/internal/canary/results", strings.NewReader(`{
		"suite":"playwright",
		"run_id":"run-123",
		"results":[
			{"test":"ui-health","status":"success","duration_seconds":1.25},
			{"test":"ui-auth-flow","status":"failure","duration_seconds":2.5,"error":"login failed"}
		]
	}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.PostResults(rec, req)

	require.Equal(t, http.StatusAccepted, rec.Code)
	require.Len(t, store.args, 2)
	assert.Equal(t, "playwright", store.args[0].Suite)
	assert.Equal(t, "ui-health", store.args[0].TestName)
	assert.Equal(t, "success", store.args[0].Status)
	assert.Equal(t, "run-123", store.args[0].RunID)
	assert.Equal(t, reportedAt, store.args[0].ReportedAt)
	assert.Equal(t, "failure", store.args[1].Status)
	assert.Equal(t, "login failed", store.args[1].ErrorMessage)
}

func TestCanaryReportHandler_PostResults_RejectsInvalidPayload(t *testing.T) {
	t.Parallel()

	handler := &routes.CanaryReportHandler{
		Store: &stubCanaryResultStore{},
	}

	testCases := []struct {
		name string
		body string
	}{
		{
			name: "missing suite",
			body: `{"results":[{"test":"ui-health","status":"success"}]}`,
		},
		{
			name: "empty results",
			body: `{"suite":"playwright","results":[]}`,
		},
		{
			name: "missing test",
			body: `{"suite":"playwright","results":[{"status":"success"}]}`,
		},
		{
			name: "invalid status",
			body: `{"suite":"playwright","results":[{"test":"ui-health","status":"passed"}]}`,
		},
		{
			name: "negative duration",
			body: `{"suite":"playwright","results":[{"test":"ui-health","status":"success","duration_seconds":-1}]}`,
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodPost, "/internal/canary/results", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			handler.PostResults(rec, req)

			assert.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}
}

func TestCanaryReportHandler_PostResults_StoreErrorReturns500(t *testing.T) {
	t.Parallel()

	handler := &routes.CanaryReportHandler{
		Store: &stubCanaryResultStore{err: assert.AnError},
	}

	req := httptest.NewRequest(http.MethodPost, "/internal/canary/results", strings.NewReader(`{
		"suite":"playwright",
		"results":[{"test":"ui-health","status":"success"}]
	}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.PostResults(rec, req)

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func (s *stubCanaryResultStore) ResolveCanaryAlertIncidents(context.Context, clusterdb.ResolveCanaryAlertIncidentsParams) (int64, error) {
	return 0, nil
}
