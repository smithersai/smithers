package repohostserver

import (
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

func TestMetrics_H_NewMetricsReportsRegistrationErrors(t *testing.T) {
	tests := []struct {
		name      string
		duplicate string
	}{
		{name: "operation_duration", duplicate: "smithers_repo_host_operation_duration_seconds"},
		{name: "service_up", duplicate: "smithers_repo_host_service_up"},
		{name: "service_health", duplicate: "smithers_repo_host_service_health"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			registry := metricsHRegistryWithDuplicate(t, tt.duplicate)

			_, err := newMetrics(registry)
			if err == nil {
				t.Fatal("expected registration error")
			}
			if !strings.Contains(err.Error(), tt.duplicate) {
				t.Fatalf("registration error %q does not mention %q", err.Error(), tt.duplicate)
			}
		})
	}
}

func metricsHRegistryWithDuplicate(t *testing.T, name string) *prometheus.Registry {
	t.Helper()
	registry := prometheus.NewRegistry()
	err := registry.Register(prometheus.NewGauge(prometheus.GaugeOpts{
		Name: name,
		Help: "duplicate metric used to exercise registration errors",
	}))
	if err != nil {
		t.Fatalf("register duplicate metric %q: %v", name, err)
	}
	return registry
}
