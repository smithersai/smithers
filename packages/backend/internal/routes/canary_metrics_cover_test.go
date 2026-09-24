package routes

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type canaryMetricsCovQuerier struct {
	rows         []db.ListLatestCanaryStepStatusesRow
	results      []clusterdb.CanaryResult
	rowsErr      error
	resultsErr   error
	workflowPath string
}

func (q *canaryMetricsCovQuerier) ListLatestCanaryStepStatuses(ctx context.Context, workflowPath string) ([]db.ListLatestCanaryStepStatusesRow, error) {
	q.workflowPath = workflowPath
	if q.rowsErr != nil {
		return nil, q.rowsErr
	}
	return q.rows, nil
}

func (q *canaryMetricsCovQuerier) ListCanaryResults(ctx context.Context) ([]clusterdb.CanaryResult, error) {
	if q.resultsErr != nil {
		return nil, q.resultsErr
	}
	return q.results, nil
}

func canaryMetricsCovCollect(t *testing.T, collector prometheus.Collector) string {
	t.Helper()
	reg := prometheus.NewRegistry()
	reg.MustRegister(collector)
	rec := httptest.NewRecorder()
	promhttp.HandlerFor(reg, promhttp.HandlerOpts{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	return string(body)
}

func TestCanaryMetrics_Cov_CollectQueryBranches(t *testing.T) {
	t.Parallel()

	t.Run("workflow status success and result query failure", func(t *testing.T) {
		q := &canaryMetricsCovQuerier{
			rows: []db.ListLatestCanaryStepStatusesRow{
				{Name: "canary-auth", Status: "success"},
				{Name: "canary-unknown", Status: "success"},
				{Name: "canary-repo", Status: "failure"},
			},
			resultsErr: errors.New("canary results unavailable"),
		}
		output := canaryMetricsCovCollect(t, NewCanaryStatusCollector(q))

		assert.Equal(t, CanaryWorkflowPath, q.workflowPath)
		assert.Contains(t, output, `smithers_canary_test_status{test="auth"} 1`)
		assert.Contains(t, output, `smithers_canary_test_status{test="repo"} 0`)
		assert.NotContains(t, output, `test="unknown"`)
		assert.Contains(t, output, `smithers_canary_suite_last_reported_timestamp_seconds{suite="playwright"} 0`)
	})

	t.Run("nil querier still emits zeros", func(t *testing.T) {
		output := canaryMetricsCovCollect(t, NewCanaryStatusCollector(nil))

		assert.Contains(t, output, `smithers_canary_test_status{test="auth"} 0`)
		assert.Contains(t, output, `smithers_canary_suite_last_reported_timestamp_seconds{suite="playwright"} 0`)
	})
}
