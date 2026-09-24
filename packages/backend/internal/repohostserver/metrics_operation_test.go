package repohostserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	dto "github.com/prometheus/client_model/go"
)

// Every repo-host handler reports its duration, even when it fails early, so
// a slow or failing staged import, source pin check, append preparation, or
// wiki projection shows up on the operation-duration histogram.
func TestHandlersObserveOperationDuration(t *testing.T) {
	srv := newTestServer(t)
	handlers := map[string]func(http.ResponseWriter, *http.Request) error{
		"StagedProvisionInfoRefs":    srv.stagedProvisionInfoRefs,
		"StagedProvisionReceivePack": srv.stagedProvisionReceivePack,
		"ReadWorkspaceSource":        srv.readWorkspaceSource,
		"PrepareLandAppend":          srv.prepareLandAppend,
		"ProjectWikiRevision":        srv.projectWikiRevision,
	}
	fresh, err := NewMetrics()
	if err != nil {
		t.Fatalf("NewMetrics: %v", err)
	}
	startup, err := fresh.registry.Gather()
	if err != nil {
		t.Fatalf("gather metrics: %v", err)
	}
	for label, handler := range handlers {
		if !metricsCovHistogramLabelExists(startup, "smithers_repo_host_operation_duration_seconds", label) {
			t.Errorf("operation %q has no series at startup; add it to operationLabels", label)
		}
		t.Run(label, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			routeCtx := chi.NewRouteContext()
			routeCtx.URLParams.Add("id", "not a repo id")
			req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
			_ = handler(httptest.NewRecorder(), req)

			gathered, err := srv.metrics.registry.Gather()
			if err != nil {
				t.Fatalf("gather metrics: %v", err)
			}
			if histogramSampleCount(t, gathered, label) == 0 {
				t.Fatalf("operation %q recorded no duration sample", label)
			}
		})
	}
}

func histogramSampleCount(t *testing.T, families []*dto.MetricFamily, operation string) uint64 {
	t.Helper()
	for _, family := range families {
		if family.GetName() != "smithers_repo_host_operation_duration_seconds" {
			continue
		}
		for _, metric := range family.GetMetric() {
			for _, label := range metric.GetLabel() {
				if label.GetName() == "operation" && label.GetValue() == operation {
					return metric.GetHistogram().GetSampleCount()
				}
			}
		}
	}
	return 0
}
