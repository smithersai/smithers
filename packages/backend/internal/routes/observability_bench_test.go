package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

type benchHealthChecker struct {
	err error
}

func (b benchHealthChecker) Ping(ctx context.Context) error {
	_ = ctx
	return b.err
}

func BenchmarkHealthzHandler_Healthy(b *testing.B) {
	handler := NewHealthzHandler(benchHealthChecker{}, "")
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rec := httptest.NewRecorder()
		handler.Healthz(rec, req)
		if rec.Code != http.StatusOK {
			b.Fatalf("unexpected status: %d", rec.Code)
		}
	}
}

func BenchmarkReadyzHandler_Healthy(b *testing.B) {
	handler := NewReadyzHandler(benchHealthChecker{}, "")
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rec := httptest.NewRecorder()
		handler.Readyz(rec, req)
		if rec.Code != http.StatusOK {
			b.Fatalf("unexpected status: %d", rec.Code)
		}
	}
}

func BenchmarkMetricsHandler_ServeHTTP(b *testing.B) {
	metrics := NewSmithersMetrics()
	handler := metrics.Handler()
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			b.Fatalf("unexpected status: %d", rec.Code)
		}
	}
}
