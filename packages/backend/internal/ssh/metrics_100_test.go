package ssh

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMetrics_H_NewMetricsRegistersCollectors(t *testing.T) {
	t.Parallel()

	reg := prometheus.NewRegistry()
	metrics := NewMetrics(reg)

	require.NotNil(t, metrics)
	metrics.AuthAttempts.WithLabelValues("success").Inc()
	metrics.ActiveConns.Inc()
	metrics.GitOperations.WithLabelValues("git-upload-pack", "success").Inc()
	metrics.GitOpDuration.WithLabelValues("git-upload-pack").Observe(0.25)

	assert.Equal(t, 1.0, testutil.ToFloat64(metrics.AuthAttempts.WithLabelValues("success")))
	assert.Equal(t, 1.0, testutil.ToFloat64(metrics.ActiveConns))
	assert.Equal(t, 1.0, testutil.ToFloat64(metrics.GitOperations.WithLabelValues("git-upload-pack", "success")))

	families, err := reg.Gather()
	require.NoError(t, err)
	assert.Len(t, families, 4)
}
