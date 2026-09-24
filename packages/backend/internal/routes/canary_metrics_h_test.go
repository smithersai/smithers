package routes

import (
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
)

func TestCanaryMetrics_H_CollectPersistedPlaywrightResults(t *testing.T) {
	reportedAt := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	q := &canaryMetricsCovQuerier{
		results: []clusterdb.CanaryResult{
			{Suite: "other", TestName: "ui-health", Status: "success", ReportedAt: reportedAt.Add(time.Hour)},
			{Suite: PlaywrightCanarySuite, TestName: "unknown", Status: "success", ReportedAt: reportedAt.Add(2 * time.Hour)},
			{Suite: PlaywrightCanarySuite, TestName: "ui-health", Status: "success", ReportedAt: reportedAt},
			{Suite: PlaywrightCanarySuite, TestName: "ui-auth-flow", Status: "failure", ReportedAt: reportedAt.Add(time.Minute)},
		},
	}

	output := canaryMetricsCovCollect(t, NewCanaryStatusCollector(q))

	assert.Contains(t, output, `smithers_canary_test_status{test="ui-health"} 1`)
	assert.Contains(t, output, `smithers_canary_test_status{test="ui-auth-flow"} 0`)
	wantReportedAt := strconv.FormatFloat(float64(reportedAt.Add(time.Minute).Unix()), 'g', -1, 64)
	assert.Contains(t, output, `smithers_canary_suite_last_reported_timestamp_seconds{suite="playwright"} `+wantReportedAt)
}
