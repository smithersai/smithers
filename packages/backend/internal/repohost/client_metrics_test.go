package repohost

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/prometheus/common/expfmt"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type repoHostMetricsStub struct {
	histogram *prometheus.HistogramVec
}

func newRepoHostMetricsStub() *repoHostMetricsStub {
	return &repoHostMetricsStub{
		histogram: prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "smithers_repo_host_client_operation_duration_seconds",
				Help:    "Duration of repo-host RPC operations in seconds.",
				Buckets: []float64{0.005, 0.01, 0.05, 0.1, 1},
			},
			[]string{"operation"},
		),
	}
}

func (m *repoHostMetricsStub) ObserveRepoHostOperationDuration(operation string, seconds float64) {
	m.histogram.WithLabelValues(operation).Observe(seconds)
}

func (m *repoHostMetricsStub) formatMetric(t *testing.T) string {
	t.Helper()
	formatted, err := testutil.CollectAndFormat(
		m.histogram,
		expfmt.TypeTextPlain,
		"smithers_repo_host_client_operation_duration_seconds",
	)
	require.NoError(t, err)
	return string(formatted)
}

func TestClient_InitRepo_RecordsOperationDurationMetric(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(10 * time.Millisecond)
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(server.Close)

	metrics := newRepoHostMetricsStub()
	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token", metrics)
	err := client.InitRepo(context.Background(), "alice", "demo", "main", false)
	require.NoError(t, err)

	metricsOutput := metrics.formatMetric(t)
	assert.Contains(t, metricsOutput, `smithers_repo_host_client_operation_duration_seconds_count{operation="InitRepo"} 1`)
}

func TestClient_ProxyUploadPack_RecordsOperationDurationMetric(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(10 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(server.Close)

	metrics := newRepoHostMetricsStub()
	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token", metrics)
	err := client.ProxyUploadPack(
		context.Background(),
		"alice",
		"demo",
		bytes.NewBufferString("upload-pack-request"),
		io.Discard,
	)
	require.NoError(t, err)

	metricsOutput := metrics.formatMetric(t)
	assert.Contains(t, metricsOutput, `smithers_repo_host_client_operation_duration_seconds_count{operation="ProxyUploadPack"} 1`)
}
