package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type canaryResultsCovStore struct {
	err  error
	args []db.UpsertCanaryResultParams
}

func (s *canaryResultsCovStore) UpsertCanaryResult(ctx context.Context, arg db.UpsertCanaryResultParams) (db.CanaryResult, error) {
	s.args = append(s.args, arg)
	if s.err != nil {
		return db.CanaryResult{}, s.err
	}
	return db.CanaryResult{Suite: arg.Suite, TestName: arg.TestName, Status: arg.Status, ReportedAt: arg.ReportedAt}, nil
}

func TestCanaryResults_Cov_PostResultsValidationAndPersistence(t *testing.T) {
	t.Parallel()

	t.Run("persists trimmed suite and normalized statuses", func(t *testing.T) {
		now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
		store := &canaryResultsCovStore{}
		h := &CanaryReportHandler{Store: store, Clock: func() time.Time { return now }}
		req := httptest.NewRequest(http.MethodPost, "/canary/results", strings.NewReader(`{
			"suite":" playwright ",
			"run_id":" run-1 ",
			"results":[{"test":" ui-health ","status":"SUCCESS","duration_seconds":1.25,"error":" none "}]
		}`))
		rec := httptest.NewRecorder()

		h.PostResults(rec, req)

		require.Equal(t, http.StatusAccepted, rec.Code)
		require.Len(t, store.args, 1)
		assert.Equal(t, "playwright", store.args[0].Suite)
		assert.Equal(t, "ui-health", store.args[0].TestName)
		assert.Equal(t, "success", store.args[0].Status)
		assert.Equal(t, "run-1", store.args[0].RunID)
		assert.Equal(t, "none", store.args[0].ErrorMessage)
		assert.Equal(t, now, store.args[0].ReportedAt)
	})

	t.Run("rejects malformed result fields", func(t *testing.T) {
		cases := []struct {
			name string
			body string
			want string
		}{
			{name: "missing suite", body: `{"results":[{"test":"x","status":"success"}]}`, want: "suite is required"},
			{name: "empty results", body: `{"suite":"playwright","results":[]}`, want: "results must not be empty"},
			{name: "missing test", body: `{"suite":"playwright","results":[{"test":" ","status":"success"}]}`, want: "result test is required"},
			{name: "bad status", body: `{"suite":"playwright","results":[{"test":"x","status":"skipped"}]}`, want: "result status must be success or failure"},
			{name: "negative duration", body: `{"suite":"playwright","results":[{"test":"x","status":"success","duration_seconds":-1}]}`, want: "result duration_seconds must be non-negative"},
		}
		for _, tc := range cases {
			tc := tc
			t.Run(tc.name, func(t *testing.T) {
				h := &CanaryReportHandler{Store: &canaryResultsCovStore{}}
				rec := httptest.NewRecorder()

				h.PostResults(rec, httptest.NewRequest(http.MethodPost, "/canary/results", strings.NewReader(tc.body)))

				require.Equal(t, http.StatusBadRequest, rec.Code)
				assert.Contains(t, rec.Body.String(), tc.want)
			})
		}
	})

	t.Run("store error returns internal", func(t *testing.T) {
		h := &CanaryReportHandler{Store: &canaryResultsCovStore{err: assert.AnError}}
		req := httptest.NewRequest(http.MethodPost, "/canary/results", strings.NewReader(`{"suite":"playwright","results":[{"test":"x","status":"failure"}]}`))
		rec := httptest.NewRecorder()

		h.PostResults(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "internal server error")
	})
}

func (s *canaryResultsCovStore) ResolveCanaryAlertIncidents(context.Context, db.ResolveCanaryAlertIncidentsParams) (int64, error) {
	return 0, nil
}
