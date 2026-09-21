package alerts

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type DashboardSpec struct {
	DisplayName      string               `json:"displayName"`
	Labels           map[string]string    `json:"labels"`
	DashboardFilters []DashboardFilter    `json:"dashboardFilters"`
	Annotations      DashboardAnnotations `json:"annotations"`
	MosaicLayout     MosaicLayout         `json:"mosaicLayout"`
}

type DashboardFilter struct {
	TemplateVariable string `json:"templateVariable"`
}

type DashboardAnnotations struct {
	EventAnnotations []EventAnnotation `json:"eventAnnotations"`
}

type EventAnnotation struct {
	EventType string `json:"eventType"`
}

type MosaicLayout struct {
	Tiles []Tile `json:"tiles"`
}

type Tile struct {
	Widget Widget `json:"widget"`
}

type Widget struct {
	Title string `json:"title"`
}

func getDashboardsPath(t *testing.T) string {
	t.Helper()

	_, currentFile, _, ok := runtime.Caller(0)
	require.True(t, ok, "failed to resolve current file")

	projectRoot := filepath.Join(filepath.Dir(currentFile), "..", "..", "..")
	return filepath.Join(projectRoot, "infra", "terraform", "modules", "monitoring", "dashboards")
}

func loadDashboard(t *testing.T, path string) *DashboardSpec {
	t.Helper()

	data, err := os.ReadFile(path)
	require.NoError(t, err, "failed to read dashboard file: %s", path)

	var dashboard DashboardSpec
	require.NoError(t, json.Unmarshal(data, &dashboard), "failed to parse dashboard JSON")

	return &dashboard
}

func TestRequiredDashboards_Exist(t *testing.T) {
	t.Parallel()

	requiredDashboards := []string{
		"platform-overview.json",
		"slo-error-budget.json",
		"database.json",
		"ssh-server.json",
		"repo-host.json",
		"runner-pool.json",
		"ai-agent.json",
		"workflows.json",
		"canary.json",
		"microsandbox.json",
		"webhooks.json",
		"agent-sessions.json",
	}

	for _, dashboard := range requiredDashboards {
		dashboard := dashboard
		t.Run(dashboard, func(t *testing.T) {
			t.Parallel()

			_, err := os.Stat(filepath.Join(getDashboardsPath(t), dashboard))
			assert.NoError(t, err, "dashboard %s must exist", dashboard)
		})
	}
}

func TestDashboard_Structure(t *testing.T) {
	t.Parallel()

	entries, err := os.ReadDir(getDashboardsPath(t))
	require.NoError(t, err)

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}

		entry := entry
		t.Run(entry.Name(), func(t *testing.T) {
			t.Parallel()

			dashboard := loadDashboard(t, filepath.Join(getDashboardsPath(t), entry.Name()))
			assert.NotEmpty(t, dashboard.DisplayName, "dashboard must have a display name")
			assert.Contains(t, dashboard.Labels, "smithers", "dashboard must have the smithers label")
			if entry.Name() != "microsandbox.json" {
				assert.ElementsMatch(t, []string{"namespace", "service", "pod"}, extractDashboardFilterNames(dashboard))
			} // Microsandbox deliberately spans controller and worker clusters/namespaces.
			assert.NotEmpty(t, dashboard.MosaicLayout.Tiles, "dashboard must include tiles")
			assert.True(t, hasEventAnnotation(dashboard, "GKE_WORKLOAD_DEPLOYMENT"), "dashboard must include deployment annotations")
		})
	}
}

func TestDashboard_PanelsHaveRequiredFields(t *testing.T) {
	t.Parallel()

	entries, err := os.ReadDir(getDashboardsPath(t))
	require.NoError(t, err)

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}

		entry := entry
		t.Run(entry.Name(), func(t *testing.T) {
			t.Parallel()

			dashboard := loadDashboard(t, filepath.Join(getDashboardsPath(t), entry.Name()))
			for _, tile := range dashboard.MosaicLayout.Tiles {
				assert.NotEmpty(t, tile.Widget.Title, "each tile widget must have a title")
			}
		})
	}
}

func TestRequiredDashboards_AreProvisioned(t *testing.T) {
	t.Parallel()

	modulePath := filepath.Dir(getDashboardsPath(t))
	data, err := os.ReadFile(filepath.Join(modulePath, "main.tf"))
	require.NoError(t, err, "failed to read monitoring module")

	entries, err := os.ReadDir(getDashboardsPath(t))
	require.NoError(t, err)
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		assert.Contains(t, string(data), `dashboards/`+entry.Name(), "dashboard %s must be provisioned by Terraform", entry.Name())
	}
}

// TestDashboard_RequiredMetricsDocuments documents the metrics each dashboard should display.
// This test doesn't fail if dashboards don't exist - it documents requirements.
func TestDashboard_RequiredMetricsDocuments(t *testing.T) {
	t.Parallel()

	// Document required metrics per dashboard per infra.md §8.5
	dashboardRequirements := map[string][]string{
		"platform-overview": {
			"smithers_http_requests_total",
			"smithers_http_request_duration_seconds",
			"smithers_client_errors_total",
		},
		"database": {
			"smithers_db_query_duration_seconds",
		},
		"repo-host": {
			"smithers_repo_host_operation_duration_seconds",
		},
		"runner-pool": {
			"smithers_runner_pool_available",
			"smithers_runner_pool_claimed",
			"smithers_workflow_task_queue_depth",
			"smithers_workflow_task_queue_oldest_age_seconds",
		},
		"ai-agent": {
			"smithers_active_agent_sessions",
		},
		"workflows": {
			"smithers_workflow_runs_total",
			"smithers_workflow_duration_seconds",
		},
		"microsandbox-vm": {
			"smithers_microsandbox_vm_create_duration_seconds",
			"smithers_microsandbox_vm_create_total",
			"smithers_microsandbox_active_vms",
			"smithers_microsandbox_api_errors_total",
		},
		"webhooks": {
			"smithers_webhook_delivery_attempts_total",
			"smithers_webhook_delivery_terminal_outcomes_total",
		},
		"agent-sessions": {
			"smithers_active_agent_sessions",
			"smithers_active_agent_session_oldest_age_seconds",
			"smithers_sse_active_connections",
			"smithers_microsandbox_vm_create_duration_seconds",
			"smithers_microsandbox_vm_create_total",
		},
	}

	for dashboard, metrics := range dashboardRequirements {
		dashboard := dashboard
		metrics := metrics
		t.Run(dashboard, func(t *testing.T) {
			t.Parallel()

			path := filepath.Join(getDashboardsPath(t), dashboard+".json")
			data, err := os.ReadFile(path)
			if os.IsNotExist(err) {
				t.Skipf("dashboard %s not present", dashboard)
				return
			}
			require.NoError(t, err, "failed to read dashboard file: %s", path)

			for _, metric := range metrics {
				assert.Contains(t, string(data), metric, "dashboard %s should reference metric %s", dashboard, metric)
			}
		})
	}
}

func extractDashboardFilterNames(dashboard *DashboardSpec) []string {
	names := make([]string, 0, len(dashboard.DashboardFilters))
	for _, filter := range dashboard.DashboardFilters {
		names = append(names, filter.TemplateVariable)
	}
	return names
}

func hasEventAnnotation(dashboard *DashboardSpec, want string) bool {
	for _, annotation := range dashboard.Annotations.EventAnnotations {
		if annotation.EventType == want {
			return true
		}
	}
	return false
}
