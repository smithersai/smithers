package routes_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// ---------------------------------------------------------------------------
// CanaryStatusCollector unit tests
// Tests for the Prometheus custom collector that exposes
// smithers_canary_test_status{test} from the latest canary workflow run.
// ---------------------------------------------------------------------------

// stubCanaryQuerier satisfies routes.CanaryStatusQuerier for unit tests.
type stubCanaryQuerier struct {
	rows    []db.ListLatestCanaryStepStatusesRow
	results []clusterdb.CanaryResult
	err     error
}

func (s *stubCanaryQuerier) ListLatestCanaryStepStatuses(_ context.Context, _ string) ([]db.ListLatestCanaryStepStatusesRow, error) {
	return s.rows, s.err
}

func (s *stubCanaryQuerier) ListCanaryResults(_ context.Context) ([]clusterdb.CanaryResult, error) {
	return s.results, s.err
}

// collectMetrics registers the collector in a fresh registry, scrapes it, and
// returns the Prometheus text output.
func collectMetrics(t *testing.T, collector prometheus.Collector) string {
	t.Helper()
	reg := prometheus.NewRegistry()
	reg.MustRegister(collector)

	handler := promhttp.HandlerFor(reg, promhttp.HandlerOpts{})
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	return string(body)
}

func TestCanaryStatusCollector_AllTestsEmitted(t *testing.T) {
	t.Parallel()

	collector := routes.NewCanaryStatusCollector(&stubCanaryQuerier{})
	output := collectMetrics(t, collector)

	expected := []string{
		`smithers_canary_test_status{test="auth"}`,
		`smithers_canary_test_status{test="repo"}`,
		`smithers_canary_test_status{test="issue"}`,
		`smithers_canary_test_status{test="landing"}`,
		`smithers_canary_test_status{test="workflow"}`,
		`smithers_canary_test_status{test="search"}`,
		`smithers_canary_test_status{test="agent-session"}`,
		`smithers_canary_test_status{test="ssh"}`,
		`smithers_canary_test_status{test="webhook"}`,
		`smithers_canary_test_status{test="pair"}`,
		`smithers_canary_test_status{test="alert-webhook"}`,
		`smithers_canary_test_status{test="ui-health"}`,
		`smithers_canary_test_status{test="ui-status-boundary"}`,
		`smithers_canary_test_status{test="ui-auth-flow"}`,
		`smithers_canary_test_status{test="ui-auth-boundary"}`,
		`smithers_canary_test_status{test="ui-repo-crud"}`,
		`smithers_canary_test_status{test="ui-issue-crud"}`,
		`smithers_canary_test_status{test="ui-landing-request"}`,
		`smithers_canary_test_status{test="ui-sse-connectivity"}`,
	}

	for _, metric := range expected {
		assert.Contains(t, output, metric, "metric %q must be present in /metrics output", metric)
	}
}

func TestCanaryStatusCollector_AllZeroWhenNoData(t *testing.T) {
	t.Parallel()

	collector := routes.NewCanaryStatusCollector(&stubCanaryQuerier{})
	output := collectMetrics(t, collector)

	expected := []string{
		`smithers_canary_test_status{test="auth"} 0`,
		`smithers_canary_test_status{test="repo"} 0`,
		`smithers_canary_test_status{test="issue"} 0`,
		`smithers_canary_test_status{test="landing"} 0`,
		`smithers_canary_test_status{test="workflow"} 0`,
		`smithers_canary_test_status{test="search"} 0`,
		`smithers_canary_test_status{test="agent-session"} 0`,
		`smithers_canary_test_status{test="ssh"} 0`,
		`smithers_canary_test_status{test="webhook"} 0`,
		`smithers_canary_test_status{test="pair"} 0`,
		`smithers_canary_test_status{test="alert-webhook"} 0`,
		`smithers_canary_test_status{test="ui-health"} 0`,
		`smithers_canary_test_status{test="ui-status-boundary"} 0`,
		`smithers_canary_test_status{test="ui-auth-flow"} 0`,
		`smithers_canary_test_status{test="ui-auth-boundary"} 0`,
		`smithers_canary_test_status{test="ui-repo-crud"} 0`,
		`smithers_canary_test_status{test="ui-issue-crud"} 0`,
		`smithers_canary_test_status{test="ui-landing-request"} 0`,
		`smithers_canary_test_status{test="ui-sse-connectivity"} 0`,
		`smithers_canary_suite_last_reported_timestamp_seconds{suite="playwright"} 0`,
	}

	for _, metric := range expected {
		assert.Contains(t, output, metric, "metric %q must report 0 when no canary data exists", metric)
	}
}

func TestCanaryStatusCollector_SuccessReportsOne(t *testing.T) {
	t.Parallel()

	querier := &stubCanaryQuerier{
		rows: []db.ListLatestCanaryStepStatusesRow{
			{Name: "canary-auth", Status: "success"},
			{Name: "canary-repo", Status: "success"},
			{Name: "canary-issue", Status: "failure"},
			{Name: "canary-ssh", Status: "success"},
			{Name: "canary-pair", Status: "success"},
			{Name: "canary-alert-webhook", Status: "success"},
		},
	}

	collector := routes.NewCanaryStatusCollector(querier)
	output := collectMetrics(t, collector)

	assert.Contains(t, output, `smithers_canary_test_status{test="auth"} 1`)
	assert.Contains(t, output, `smithers_canary_test_status{test="repo"} 1`)
	assert.Contains(t, output, `smithers_canary_test_status{test="issue"} 0`)
	assert.Contains(t, output, `smithers_canary_test_status{test="ssh"} 1`)
	assert.Contains(t, output, `smithers_canary_test_status{test="pair"} 1`)
	assert.Contains(t, output, `smithers_canary_test_status{test="alert-webhook"} 1`)
	// Tests not in the DB rows should default to 0.
	assert.Contains(t, output, `smithers_canary_test_status{test="landing"} 0`)
	assert.Contains(t, output, `smithers_canary_test_status{test="workflow"} 0`)
}

func TestCanaryStatusCollector_PersistedPlaywrightResultsReportStatusAndFreshness(t *testing.T) {
	t.Parallel()

	reportedAt := time.Unix(1_710_000_000, 0).UTC()
	collector := routes.NewCanaryStatusCollector(&stubCanaryQuerier{
		results: []clusterdb.CanaryResult{
			{
				Suite:      routes.PlaywrightCanarySuite,
				TestName:   "ui-health",
				Status:     "success",
				ReportedAt: reportedAt,
			},
			{
				Suite:      routes.PlaywrightCanarySuite,
				TestName:   "ui-status-boundary",
				Status:     "success",
				ReportedAt: reportedAt.Add(15 * time.Second),
			},
			{
				Suite:      routes.PlaywrightCanarySuite,
				TestName:   "ui-auth-flow",
				Status:     "failure",
				ReportedAt: reportedAt.Add(30 * time.Second),
			},
			{
				Suite:      routes.PlaywrightCanarySuite,
				TestName:   "ui-auth-boundary",
				Status:     "success",
				ReportedAt: reportedAt.Add(45 * time.Second),
			},
		},
	})
	output := collectMetrics(t, collector)

	assert.Contains(t, output, `smithers_canary_test_status{test="ui-health"} 1`)
	assert.Contains(t, output, `smithers_canary_test_status{test="ui-status-boundary"} 1`)
	assert.Contains(t, output, `smithers_canary_test_status{test="ui-auth-flow"} 0`)
	assert.Contains(t, output, `smithers_canary_test_status{test="ui-auth-boundary"} 1`)
	assert.Contains(t, output, `smithers_canary_suite_last_reported_timestamp_seconds{suite="playwright"} 1.710000045`)
}

func TestCanaryStatusCollector_IgnoresUnknownSteps(t *testing.T) {
	t.Parallel()

	querier := &stubCanaryQuerier{
		rows: []db.ListLatestCanaryStepStatusesRow{
			{Name: "canary-auth", Status: "success"},
			{Name: "canary-unknown-test", Status: "success"},
		},
	}

	collector := routes.NewCanaryStatusCollector(querier)
	output := collectMetrics(t, collector)

	assert.Contains(t, output, `smithers_canary_test_status{test="auth"} 1`)
	assert.NotContains(t, output, `test="unknown-test"`, "unknown steps should be ignored")
}

func TestCanaryStatusCollector_DBErrorDefaultsToZero(t *testing.T) {
	t.Parallel()

	querier := &stubCanaryQuerier{
		err: assert.AnError,
	}

	collector := routes.NewCanaryStatusCollector(querier)
	output := collectMetrics(t, collector)

	// All metrics should still be emitted (as 0), not cause a scrape failure.
	assert.Contains(t, output, `smithers_canary_test_status{test="auth"} 0`)
	assert.Contains(t, output, `smithers_canary_test_status{test="repo"} 0`)
	assert.Contains(t, output, `smithers_canary_suite_last_reported_timestamp_seconds{suite="playwright"} 0`)
}

func TestCanaryStatusCollector_NilQuerier(t *testing.T) {
	t.Parallel()

	collector := routes.NewCanaryStatusCollector(nil)
	output := collectMetrics(t, collector)

	// Should emit all zeros without panicking.
	assert.Contains(t, output, `smithers_canary_test_status{test="auth"} 0`)
	assert.Contains(t, output, `smithers_canary_test_status{test="webhook"} 0`)
	assert.Contains(t, output, `smithers_canary_suite_last_reported_timestamp_seconds{suite="playwright"} 0`)
}

func TestCanaryStatusCollector_HelpAndTypeLine(t *testing.T) {
	t.Parallel()

	collector := routes.NewCanaryStatusCollector(&stubCanaryQuerier{})
	output := collectMetrics(t, collector)

	assert.Contains(t, output, "# HELP smithers_canary_test_status")
	assert.Contains(t, output, "# TYPE smithers_canary_test_status gauge")
	assert.Contains(t, output, "# HELP smithers_canary_suite_last_reported_timestamp_seconds")
	assert.Contains(t, output, "# TYPE smithers_canary_suite_last_reported_timestamp_seconds gauge")
}

func TestCanaryStatusCollector_OnlySuccessIsOne(t *testing.T) {
	t.Parallel()

	// Verify that statuses other than "success" all map to 0.
	statuses := []string{"failure", "running", "cancelled", "pending", "queued"}
	for _, status := range statuses {
		querier := &stubCanaryQuerier{
			rows: []db.ListLatestCanaryStepStatusesRow{
				{Name: "canary-auth", Status: status},
			},
		}
		collector := routes.NewCanaryStatusCollector(querier)
		output := collectMetrics(t, collector)

		assert.Contains(t, output, `smithers_canary_test_status{test="auth"} 0`,
			"status %q should report 0, only 'success' reports 1", status)
	}
}

func TestCanaryStatusCollector_IntegratesWithSmithersMetrics(t *testing.T) {
	t.Parallel()

	// Verify the collector can be registered alongside SmithersMetrics
	// (as done in cmd/server/main.go).
	m := routes.NewSmithersMetrics()
	collector := routes.NewCanaryStatusCollector(&stubCanaryQuerier{
		rows: []db.ListLatestCanaryStepStatusesRow{
			{Name: "canary-auth", Status: "success"},
		},
	})

	m.MustRegister(collector)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body, err := io.ReadAll(rec.Body)
	require.NoError(t, err)
	output := string(body)

	// Both standard metrics and canary metrics should appear.
	assert.Contains(t, output, "smithers_active_agent_sessions")
	assert.Contains(t, output, `smithers_canary_test_status{test="auth"} 1`)
}
