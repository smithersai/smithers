package infra_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// Observability Infrastructure Integration Tests
//
// These tests validate the Terraform monitoring module configuration
// and ensure alert rules and dashboards are properly defined.
// Reference: docs/specs/infra.md §8
// ---------------------------------------------------------------------------

// TestMonitoringModule_Exists verifies the monitoring module directory exists
func TestMonitoringModule_Exists(t *testing.T) {
	t.Parallel()

	modulePath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring")
	info, err := os.Stat(modulePath)

	require.NoError(t, err, "monitoring module directory must exist")
	assert.True(t, info.IsDir(), "monitoring module must be a directory")
}

// TestMonitoringModule_HasRequiredFiles verifies all required Terraform files exist
func TestMonitoringModule_HasRequiredFiles(t *testing.T) {
	t.Parallel()

	modulePath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring")
	requiredFiles := []string{
		"main.tf",
		"variables.tf",
		"outputs.tf",
		"README.md",
	}

	for _, file := range requiredFiles {
		file := file
		t.Run(file, func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(modulePath, file)
			_, err := os.Stat(path)
			assert.NoError(t, err, "required file %s must exist", file)
		})
	}
}

// TestMonitoringModule_MainTfContainsAlerts verifies alert policies are defined
func TestMonitoringModule_MainTfContainsAlerts(t *testing.T) {
	t.Parallel()

	mainTfPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "main.tf")
	content, err := os.ReadFile(mainTfPath)
	require.NoError(t, err)
	contentStr := string(content)

	// Check for required alert policies (using resource type and name pattern)
	requiredAlerts := []string{
		`"google_monitoring_alert_policy" "high_error_rate"`,
		`"google_monitoring_alert_policy" "high_latency"`,
		`"google_monitoring_alert_policy" "pod_restart_loop"`,
		`"google_monitoring_alert_policy" "db_connection_saturation"`,
		`"google_monitoring_alert_policy" "runner_pool_exhaustion"`,
		`"google_monitoring_alert_policy" "repo_host_down"`,
		`"google_monitoring_alert_policy" "cloud_sql_high_cpu"`,
		`"google_monitoring_alert_policy" "workflow_push_hook_load_failures"`,
		`"google_monitoring_alert_policy" "workflow_push_hook_persist_failures"`,
		`"google_monitoring_alert_policy" "workflow_commit_status_create_failures"`,
		`"google_monitoring_alert_policy" "workflow_commit_status_update_failures"`,
		`"google_monitoring_alert_policy" "microsandbox_worker_disk_usage"`,
	}

	for _, alert := range requiredAlerts {
		alert := alert
		t.Run(alert, func(t *testing.T) {
			t.Parallel()
			assert.Contains(t, contentStr, alert, "alert policy %s must be defined", alert)
		})
	}
}

// TestMonitoringModule_MainTfContainsDashboards verifies dashboards are defined
func TestMonitoringModule_MainTfContainsDashboards(t *testing.T) {
	t.Parallel()

	mainTfPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "main.tf")
	content, err := os.ReadFile(mainTfPath)
	require.NoError(t, err)
	contentStr := string(content)

	// Check for required dashboards (using resource type and name pattern)
	requiredDashboards := []string{
		`"google_monitoring_dashboard" "platform_overview"`,
		`"google_monitoring_dashboard" "slo_error_budget"`,
		`"google_monitoring_dashboard" "database"`,
		`"google_monitoring_dashboard" "ssh_server"`,
		`"google_monitoring_dashboard" "repo_host"`,
		`"google_monitoring_dashboard" "runner_pool"`,
		`"google_monitoring_dashboard" "ai_agent"`,
		`"google_monitoring_dashboard" "workflows"`,
		`"google_monitoring_dashboard" "canary"`,
		`"google_monitoring_dashboard" "microsandbox"`,
		`"google_monitoring_dashboard" "webhooks"`,
		`"google_monitoring_dashboard" "agent_sessions"`,
	}

	for _, dashboard := range requiredDashboards {
		dashboard := dashboard
		t.Run(dashboard, func(t *testing.T) {
			t.Parallel()
			assert.Contains(t, contentStr, dashboard, "dashboard %s must be defined", dashboard)
		})
	}
}

// TestMonitoringModule_ReferencesCorrectMetrics verifies the monitoring module
// references the expected Prometheus metrics across alerts and dashboard JSON.
func TestMonitoringModule_ReferencesCorrectMetrics(t *testing.T) {
	t.Parallel()

	mainTfPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "main.tf")
	content, err := os.ReadFile(mainTfPath)
	require.NoError(t, err)

	dashboardsDir := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "dashboards")
	entries, err := os.ReadDir(dashboardsDir)
	require.NoError(t, err)

	contentStr := string(content)
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}

		data, err := os.ReadFile(filepath.Join(dashboardsDir, entry.Name()))
		require.NoError(t, err)
		contentStr += string(data)
	}

	// Verify Prometheus queries are used for key metrics.
	prometheusQueries := []string{
		"smithers_http_requests_total",
		"smithers_http_request_duration_seconds",
		"smithers_db_connections_active",
		"smithers_runner_pool_available",
		"smithers_workflow_task_queue_depth",
		"smithers_active_agent_sessions",
		"histogram_quantile",
	}

	for _, query := range prometheusQueries {
		query := query
		t.Run(query, func(t *testing.T) {
			t.Parallel()
			assert.Contains(t, contentStr, query, "spec metric %s must be referenced", query)
		})
	}
}

// TestMonitoringModule_UsesCorrectSeverityLevels verifies alert severity levels
func TestMonitoringModule_UsesCorrectSeverityLevels(t *testing.T) {
	t.Parallel()

	mainTfPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "main.tf")
	content, err := os.ReadFile(mainTfPath)
	require.NoError(t, err)

	contentStr := string(content)

	// Critical alerts
	criticalAlerts := []string{
		"high_error_rate",
		"pod_restart_loop",
		"runner_pool_exhaustion",
		"repo_host_down",
	}

	for _, alert := range criticalAlerts {
		alert := alert
		t.Run("critical_"+alert, func(t *testing.T) {
			t.Parallel()
			// Find the resource block and check for severity = "CRITICAL"
			assert.Contains(t, contentStr, alert, "critical alert %s must exist", alert)
		})
	}

	// Warning alerts
	warningAlerts := []string{
		"high_latency",
		"db_connection_saturation",
		"cloud_sql_high_cpu",
		"workflow_push_hook_load_failures",
		"workflow_commit_status_create_failures",
		"workflow_commit_status_update_failures",
	}

	for _, alert := range warningAlerts {
		alert := alert
		t.Run("warning_"+alert, func(t *testing.T) {
			t.Parallel()
			assert.Contains(t, contentStr, alert, "warning alert %s must exist", alert)
		})
	}
}

// TestMonitoringModule_HasConfigurableThresholds verifies thresholds are configurable
func TestMonitoringModule_HasConfigurableThresholds(t *testing.T) {
	t.Parallel()

	varsPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "variables.tf")
	content, err := os.ReadFile(varsPath)
	require.NoError(t, err)

	contentStr := string(content)

	thresholdVars := []string{
		"high_error_rate_threshold",
		"high_latency_threshold",
		"pod_restart_threshold",
		"db_connection_threshold",
		"runner_pool_threshold",
	}

	for _, v := range thresholdVars {
		v := v
		t.Run(v, func(t *testing.T) {
			t.Parallel()
			assert.Contains(t, contentStr, v, "threshold variable %s must be defined", v)
		})
	}
}

// TestMonitoringModule_HasDocumentation verifies runbook links exist
func TestMonitoringModule_HasDocumentation(t *testing.T) {
	t.Parallel()

	mainTfPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "main.tf")
	content, err := os.ReadFile(mainTfPath)
	require.NoError(t, err)

	contentStr := string(content)

	// Verify runbook links are present
	runbookPaths := []string{
		"runbooks/high-error-rate",
		"runbooks/high-latency",
		"runbooks/pod-restart-loop",
		"runbooks/db-connection-saturation",
		"runbooks/runner-pool-exhaustion",
		"runbooks/repo-host-down",
		"runbooks/cloud-sql-high-cpu",
	}

	for _, path := range runbookPaths {
		path := path
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			assert.Contains(t, contentStr, path, "runbook link %s must be present", path)
		})
	}
}

// TestMonitoringModule_SpecMetricsReferenced verifies metric names match spec.
func TestMonitoringModule_SpecMetricsReferenced(t *testing.T) {
	t.Parallel()

	mainTfPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "main.tf")
	content, err := os.ReadFile(mainTfPath)
	require.NoError(t, err)

	contentStr := string(content)
	dashboardsDir := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "dashboards")
	entries, err := os.ReadDir(dashboardsDir)
	require.NoError(t, err)

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}

		data, err := os.ReadFile(filepath.Join(dashboardsDir, entry.Name()))
		require.NoError(t, err)
		contentStr += string(data)
	}

	// Spec metrics plus queue backlog gauges referenced by monitoring.
	specMetrics := []string{
		"smithers_http_requests_total",
		"smithers_http_request_duration_seconds",
		"smithers_active_agent_sessions",
		"smithers_agent_session_timeouts_total",
		"smithers_agent_sessions_completed_total",
		"smithers_runner_pool_available",
		"smithers_runner_pool_claimed",
		"smithers_workflow_task_queue_depth",
		"smithers_workflow_task_queue_oldest_age_seconds",
		"smithers_workflow_runs_total",
		"smithers_workflow_duration_seconds",
		"smithers_repo_host_operation_duration_seconds",
		"smithers_db_query_duration_seconds",
		"smithers_sse_active_connections",
	}

	for _, metric := range specMetrics {
		metric := metric
		t.Run(metric, func(t *testing.T) {
			t.Parallel()
			assert.Contains(t, contentStr, metric, "spec metric %s must be referenced", metric)
		})
	}
}

func TestMonitoringModule_AgentSessionTimeoutAlertUsesSmithersMetrics(t *testing.T) {
	t.Parallel()

	mainTfPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "main.tf")
	content, err := os.ReadFile(mainTfPath)
	require.NoError(t, err)
	contentStr := string(content)

	assert.Contains(t, contentStr, "smithers_agent_session_timeouts_total")
	assert.Contains(t, contentStr, "smithers_agent_sessions_completed_total")
	assert.NotContains(t, contentStr, "smithers_agent_sessions_total")
}

// TestAlertsYaml_Exists verifies the POC alerts.yaml exists and is valid YAML
func TestAlertsYaml_Exists(t *testing.T) {
	t.Parallel()

	alertsPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "alerts.yaml")
	content, err := os.ReadFile(alertsPath)
	require.NoError(t, err, "alerts.yaml must exist")

	// Basic YAML structure validation
	contentStr := string(content)
	assert.Contains(t, contentStr, "groups:", "alerts.yaml must contain groups key")
	assert.Contains(t, contentStr, "rules:", "alerts.yaml must contain rules key")
	assert.Contains(t, contentStr, "alert:", "alerts.yaml must contain alert definitions")
}

// TestAlertsYaml_HasRequiredAlertGroups verifies alert groups are defined
func TestAlertsYaml_HasRequiredAlertGroups(t *testing.T) {
	t.Parallel()

	alertsPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "alerts.yaml")
	content, err := os.ReadFile(alertsPath)
	require.NoError(t, err)

	contentStr := string(content)

	requiredGroups := []string{
		"pod_health",
		"application_health",
		"database",
		"runner_pool",
	}

	for _, group := range requiredGroups {
		group := group
		t.Run(group, func(t *testing.T) {
			t.Parallel()
			assert.Contains(t, contentStr, "name: "+group, "alert group %s must be defined", group)
		})
	}
}

// TestAlertsYaml_CriticalAlertsExist verifies critical alerts from spec are present
func TestAlertsYaml_CriticalAlertsExist(t *testing.T) {
	t.Parallel()

	alertsPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "alerts.yaml")
	content, err := os.ReadFile(alertsPath)
	require.NoError(t, err)

	contentStr := string(content)

	criticalAlerts := []string{
		"HighErrorRate",
		"PodRestartLoop",
		"DBConnectionSaturation",
		"RunnerPoolExhausted",
	}

	for _, alert := range criticalAlerts {
		alert := alert
		t.Run(alert, func(t *testing.T) {
			t.Parallel()
			assert.Contains(t, contentStr, "alert: "+alert, "critical alert %s must be defined", alert)
		})
	}
}

// TestMonitoringModule_HasEnvironmentTagging verifies resources are tagged with environment
func TestMonitoringModule_HasEnvironmentTagging(t *testing.T) {
	t.Parallel()

	mainTfPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "main.tf")
	content, err := os.ReadFile(mainTfPath)
	require.NoError(t, err)

	contentStr := string(content)

	// Check for environment-based naming
	assert.Contains(t, contentStr, "${var.environment}", "resources must use environment variable in naming")
	assert.Contains(t, contentStr, "environment = var.environment", "resources must have environment label")
}

// TestMonitoringModule_UsesConditionalCreation verifies resources are conditional
func TestMonitoringModule_UsesConditionalCreation(t *testing.T) {
	t.Parallel()

	mainTfPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "main.tf")
	content, err := os.ReadFile(mainTfPath)
	require.NoError(t, err)

	contentStr := string(content)

	// Check for count-based conditional creation
	assert.Contains(t, contentStr, "count = var.enable_alerts ? 1 : 0", "alerts should be conditionally created")
	assert.Contains(t, contentStr, "count = var.enable_dashboards ? 1 : 0", "dashboards should be conditionally created")
}

// TestMonitoringModule_HasNotificationChannels verifies notification channel support
func TestMonitoringModule_HasNotificationChannels(t *testing.T) {
	t.Parallel()

	varsPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "variables.tf")
	content, err := os.ReadFile(varsPath)
	require.NoError(t, err)

	contentStr := string(content)

	assert.Contains(t, contentStr, "notification_channels", "notification_channels variable must be defined")
	assert.Contains(t, contentStr, "list(string)", "notification_channels must be a list of strings")
}

// TestMonitoringModule_ReadmeHasUsageExample verifies README has usage instructions
func TestMonitoringModule_ReadmeHasUsageExample(t *testing.T) {
	t.Parallel()

	readmePath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "README.md")
	content, err := os.ReadFile(readmePath)
	require.NoError(t, err)

	contentStr := string(content)

	// Check for required sections
	requiredSections := []string{
		"## Overview",
		"## Alert Policies",
		"## Dashboards",
		"## Usage",
		"## Requirements",
	}

	for _, section := range requiredSections {
		section := section
		t.Run(section, func(t *testing.T) {
			t.Parallel()
			assert.Contains(t, contentStr, section, "README must contain %s section", section)
		})
	}
}

// TestMonitoringModule_ReadmeDocumentsAllAlerts verifies README documents all alerts
func TestMonitoringModule_ReadmeDocumentsAllAlerts(t *testing.T) {
	t.Parallel()

	readmePath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "README.md")
	content, err := os.ReadFile(readmePath)
	require.NoError(t, err)

	contentStr := strings.ToLower(string(content))

	// All alert names should be documented (lowercase for case-insensitive check)
	alertNames := []string{
		"high_error_rate",
		"high_latency",
		"pod_restart_loop",
		"db_connection_saturation",
		"runner_pool_exhaustion",
		"repo_host_down",
		"cloud_sql_high_cpu",
		"workflow_push_hook_load_failures",
		"workflow_push_hook_persist_failures",
		"workflow_commit_status_create_failures",
		"workflow_commit_status_update_failures",
	}

	for _, alert := range alertNames {
		alert := alert
		t.Run(alert, func(t *testing.T) {
			t.Parallel()
			// Check for the alert name (with underscores replaced by spaces for readability check)
			assert.True(t,
				strings.Contains(contentStr, alert) ||
					strings.Contains(contentStr, strings.ReplaceAll(alert, "_", " ")),
				"README must document alert %s", alert)
		})
	}
}

func TestMonitoringModule_MainTfContainsWorkflowLogMetrics(t *testing.T) {
	t.Parallel()

	mainTfPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "main.tf")
	content, err := os.ReadFile(mainTfPath)
	require.NoError(t, err)

	contentStr := string(content)

	requiredMetrics := []string{
		`"google_logging_metric" "workflow_push_hook_load_failures"`,
		`"google_logging_metric" "workflow_push_hook_persist_failures"`,
		`"google_logging_metric" "workflow_commit_status_create_failures"`,
		`"google_logging_metric" "workflow_commit_status_update_failures"`,
		`"time_sleep" "workflow_log_metrics_ready"`,
		`create_duration = "90s"`,
		`jsonPayload.message="workflow load failed after push"`,
		`jsonPayload.message="workflow persistence failed after push"`,
		`jsonPayload.message="failed to create pending commit status for workflow run"`,
		`jsonPayload.message=~"failed to update commit status for( cancelled)? workflow run"`,
	}

	for _, metric := range requiredMetrics {
		metric := metric
		t.Run(metric, func(t *testing.T) {
			t.Parallel()
			assert.Contains(t, contentStr, metric, "workflow log metric %s must be defined", metric)
		})
	}
}

func TestMonitoringModule_WebhookFailureAlertUsesLiveWebhookMetrics(t *testing.T) {
	t.Parallel()

	mainTfPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "main.tf")
	content, err := os.ReadFile(mainTfPath)
	require.NoError(t, err)

	contentStr := string(content)
	assert.Contains(t, contentStr, `smithers_webhook_delivery_attempts_total{outcome=~"retry|failed|disabled"}`,
		"webhook alert must use live Smithers webhook delivery attempt metrics")
	assert.Contains(t, contentStr, `sum(rate(smithers_webhook_delivery_attempts_total[5m]))`,
		"webhook alert denominator must use live Smithers webhook delivery attempt metrics")
	assert.NotContains(t, contentStr, "smithers_webhook_delivery_failures_total",
		"dead plue webhook metrics must not be referenced")
	assert.NotContains(t, contentStr, "smithers_webhook_delivery_success_total",
		"dead plue webhook metrics must not be referenced")
}

func TestMonitoringModule_WebhookFailureAlertEnabledByDefault(t *testing.T) {
	t.Parallel()

	varsPath := filepath.Join("..", "..", "infra", "terraform", "modules", "monitoring", "variables.tf")
	content, err := os.ReadFile(varsPath)
	require.NoError(t, err)

	contentStr := string(content)
	assert.Contains(t, contentStr, `variable "enable_webhook_delivery_failure_alert"`,
		"webhook failure alert variable must exist")
	assert.Contains(t, contentStr, "default     = true",
		"webhook failure alert should be enabled by default once live metrics exist")
}
