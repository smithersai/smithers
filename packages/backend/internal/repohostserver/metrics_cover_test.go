package repohostserver

import (
	"strings"
	"testing"

	dto "github.com/prometheus/client_model/go"
)

func TestMetrics_Cov_SetServiceHealthFalseRecordsZero(t *testing.T) {
	metrics, err := NewMetrics()
	if err != nil {
		t.Fatalf("NewMetrics returned error: %v", err)
	}

	metrics.SetServiceHealth(false)
	gathered, err := metrics.registry.Gather()
	if err != nil {
		t.Fatalf("gather metrics: %v", err)
	}

	got, ok := metricsCovGaugeValue(gathered, "smithers_repo_host_service_health")
	if !ok {
		t.Fatal("service health metric not found")
	}
	if got != 0 {
		t.Fatalf("service health gauge = %v, want 0", got)
	}
}

func TestMetrics_Cov_StartOperationObservesCustomOperation(t *testing.T) {
	metrics, err := NewMetrics()
	if err != nil {
		t.Fatalf("NewMetrics returned error: %v", err)
	}

	done := metrics.StartOperation("AdHocOperation")
	done()

	gathered, err := metrics.registry.Gather()
	if err != nil {
		t.Fatalf("gather metrics: %v", err)
	}
	if !metricsCovHistogramLabelExists(gathered, "smithers_repo_host_operation_duration_seconds", "AdHocOperation") {
		t.Fatal("expected histogram for AdHocOperation to be observed")
	}
}

func metricsCovGaugeValue(families []*dto.MetricFamily, name string) (float64, bool) {
	for _, family := range families {
		if family.GetName() != name {
			continue
		}
		for _, metric := range family.GetMetric() {
			if metric.GetGauge() != nil {
				return metric.GetGauge().GetValue(), true
			}
		}
	}
	return 0, false
}

func metricsCovHistogramLabelExists(families []*dto.MetricFamily, name, operation string) bool {
	for _, family := range families {
		if family.GetName() != name && !strings.HasPrefix(family.GetName(), name+"_") {
			continue
		}
		for _, metric := range family.GetMetric() {
			for _, label := range metric.GetLabel() {
				if label.GetName() == "operation" && label.GetValue() == operation {
					return true
				}
			}
		}
	}
	return false
}
