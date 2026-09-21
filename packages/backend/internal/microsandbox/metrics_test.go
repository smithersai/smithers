package microsandbox

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	dto "github.com/prometheus/client_model/go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMetricsExportControllerPlacementGauges(t *testing.T) {
	registry := prometheus.NewRegistry()
	metrics := NewMetrics(registry)

	metrics.SetHostStates(map[string]float64{"ready": 2, "draining": 1})
	metrics.SetInstanceStates(map[string]float64{"running": 7, "degraded": 1})

	families, err := registry.Gather()
	require.NoError(t, err)

	assertMetricFamilyStates(t, families, "plue_microsandbox_hosts", map[string]float64{
		"ready": 2, "draining": 1, "stale": 0, "fenced": 0,
	})
	assertMetricFamilyStates(t, families, "plue_microsandbox_instances", map[string]float64{
		"starting": 0, "running": 7, "stopping": 0, "stopped": 0,
		"restart_pending": 0, "recovering": 0, "deleting": 0,
		"degraded": 1, "failed": 0,
	})
}

func assertMetricFamilyStates(t *testing.T, families []*dto.MetricFamily, name string, expected map[string]float64) {
	t.Helper()
	for _, family := range families {
		if family.GetName() != name {
			continue
		}
		actual := make(map[string]float64, len(family.Metric))
		for _, metric := range family.Metric {
			for _, label := range metric.Label {
				if label.GetName() == "state" {
					actual[label.GetValue()] = metric.GetGauge().GetValue()
				}
			}
		}
		assert.Equal(t, expected, actual)
		return
	}
	t.Fatalf("metric family %q was not exported", name)
}

func TestMetricsUseOnlyBoundedRequestLabels(t *testing.T) {
	registry := prometheus.NewRegistry()
	metrics := NewMetrics(registry)
	handler := metrics.Instrument("worker", http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusServiceUnavailable)
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/contains/customer/repository", nil))
	assert.Equal(t, float64(1), testutil.ToFloat64(metrics.requests.WithLabelValues("worker", "unmatched", "POST", "5xx")))
	metrics.ObserveWorkerHeartbeat(true, false,
		WorkerCapacity{CPUMillis: 7000, VMs: 24}, WorkerCapacity{CPUMillis: 1000, VMs: 1},
		[]WorkerInventoryItem{{SandboxID: "must-not-be-a-label", State: "running"}},
	)
	assert.Equal(t, float64(1), testutil.ToFloat64(metrics.inventory.WithLabelValues("running")))
}

func TestMetricsRecordReconcileHealth(t *testing.T) {
	registry := prometheus.NewRegistry()
	metrics := NewMetrics(registry)
	metrics.ObserveReconcile(false, time.Unix(100, 0))
	metrics.ObserveReconcile(true, time.Unix(200, 0))

	assert.Equal(t, float64(1), testutil.ToFloat64(metrics.reconcileError))
	assert.Equal(t, float64(200), testutil.ToFloat64(metrics.reconcileLast))
}

func TestMetricsRecordWorkerDiskUsage(t *testing.T) {
	registry := prometheus.NewRegistry()
	metrics := NewMetrics(registry)
	metrics.SetWorkerDiskUsage(.76)

	assert.InDelta(t, .76, testutil.ToFloat64(metrics.workerDiskUsage), .001)
}
