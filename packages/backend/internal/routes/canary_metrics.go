package routes

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

const CanaryWorkflowPath = ".smithers/workflows/canary.tsx"
const PlaywrightCanarySuite = "playwright"

// WorkflowCanarySuite is the suite label the backend probe suite
// (.smithers/workflows/canary-runner.ts) reports under when it runs as an
// in-cluster CronJob rather than as a Smithers workflow. Without it, every
// backend probe result was persisted by POST /internal/canary/results and then
// silently dropped here, leaving smithers_canary_test_status pinned at 0 for
// all ~21 backend tests no matter how green the probes actually were.
const WorkflowCanarySuite = "workflow"

// reportedCanarySuites are the suites whose results feed
// smithers_canary_test_status and whose freshness is published as
// smithers_canary_suite_last_reported_timestamp_seconds. A suite missing from
// this set is stored but invisible to monitoring.
var reportedCanarySuites = []string{PlaywrightCanarySuite, WorkflowCanarySuite}

var workflowCanaryTests = []string{
	"auth",
	"repo",
	"issue",
	"landing",
	"workflow",
	"search",
	"search-code",
	"workspace",
	"agent-session",
	"ssh",
	"ssh-host",
	"webhook",
	"pair",
	"alert-webhook",
	"cli",
	"commit-status",
	// Negative canaries: these assert the platform still refuses what it must
	// refuse (revoked credentials, out-of-scope writes). A permissive
	// regression is invisible to every positive probe.
	"revoked-token",
	"token-scope",
	// Sign-in entry point and realtime (PG LISTEN/NOTIFY -> SSE) transport.
	"oauth",
	"sse",
	// Reclaims fixtures stranded when a probe is killed before cleanup runs.
	"orphan-sweep",
}

var playwrightCanaryTests = []string{
	"ui-health",
	"ui-status-boundary",
	// Watches the canary reporting pipeline itself, so a canary that stops
	// reporting cannot masquerade as a healthy system.
	"ui-canary-pipeline",
	"ui-auth-flow",
	"ui-auth-boundary",
	"ui-repo-crud",
	"ui-issue-crud",
	"ui-landing-request",
	"ui-sse-connectivity",
}

var productionCanaryTests = append(append([]string{}, workflowCanaryTests...), playwrightCanaryTests...)

type CanaryStatusQuerier interface {
	ListLatestCanaryStepStatuses(ctx context.Context, workflowPath string) ([]db.ListLatestCanaryStepStatusesRow, error)
	ListCanaryResults(ctx context.Context) ([]db.CanaryResult, error)
}

type CanaryStatusCollector struct {
	queries             CanaryStatusQuerier
	statusDesc          *prometheus.Desc
	suiteReportedAtDesc *prometheus.Desc
	timeout             time.Duration
}

func NewCanaryStatusCollector(queries CanaryStatusQuerier) *CanaryStatusCollector {
	return &CanaryStatusCollector{
		queries: queries,
		statusDesc: prometheus.NewDesc(
			"smithers_canary_test_status",
			"Latest persisted production canary status by test (1=success, 0=non-success).",
			[]string{"test"},
			nil,
		),
		suiteReportedAtDesc: prometheus.NewDesc(
			"smithers_canary_suite_last_reported_timestamp_seconds",
			"Unix timestamp of the latest reported production canary result by suite.",
			[]string{"suite"},
			nil,
		),
		timeout: 3 * time.Second,
	}
}

func (c *CanaryStatusCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.statusDesc
	ch <- c.suiteReportedAtDesc
}

func (c *CanaryStatusCollector) Collect(ch chan<- prometheus.Metric) {
	statuses := make(map[string]float64, len(productionCanaryTests))
	for _, testName := range productionCanaryTests {
		statuses[testName] = 0
	}

	if c.queries != nil {
		ctx, cancel := context.WithTimeout(context.Background(), c.timeout)
		rows, err := c.queries.ListLatestCanaryStepStatuses(ctx, CanaryWorkflowPath)
		cancel()
		if err != nil {
			slog.Warn("failed to collect canary metric state", "error", err)
		} else {
			for _, row := range rows {
				testName := strings.TrimPrefix(row.Name, "canary-")
				if _, ok := statuses[testName]; !ok {
					continue
				}
				if row.Status == "success" {
					statuses[testName] = 1
				}
			}
		}

		ctx, cancel = context.WithTimeout(context.Background(), c.timeout)
		results, err := c.queries.ListCanaryResults(ctx)
		cancel()

		reportedAt := make(map[string]float64, len(reportedCanarySuites))
		for _, suite := range reportedCanarySuites {
			reportedAt[suite] = 0
		}

		if err != nil {
			slog.Warn("failed to collect persisted canary results", "error", err)
		} else {
			for _, result := range results {
				if _, tracked := reportedAt[result.Suite]; !tracked {
					continue
				}
				if _, ok := statuses[result.TestName]; !ok {
					continue
				}
				if result.Status == "success" {
					statuses[result.TestName] = 1
				}
				resultReportedAt := float64(result.ReportedAt.Unix())
				if resultReportedAt > reportedAt[result.Suite] {
					reportedAt[result.Suite] = resultReportedAt
				}
			}
		}

		// Emit in a fixed order so the exposition is deterministic.
		for _, suite := range reportedCanarySuites {
			ch <- prometheus.MustNewConstMetric(
				c.suiteReportedAtDesc,
				prometheus.GaugeValue,
				reportedAt[suite],
				suite,
			)
		}
	} else {
		for _, suite := range reportedCanarySuites {
			ch <- prometheus.MustNewConstMetric(
				c.suiteReportedAtDesc,
				prometheus.GaugeValue,
				0,
				suite,
			)
		}
	}

	for _, testName := range productionCanaryTests {
		ch <- prometheus.MustNewConstMetric(c.statusDesc, prometheus.GaugeValue, statuses[testName], testName)
	}
}
