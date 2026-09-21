package sandbox

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	dto "github.com/prometheus/client_model/go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMetrics_Cov_AllHelpersObserveAndNilReceiversReturn(t *testing.T) {
	t.Parallel()

	var nilMetrics *SandboxMetrics
	nilMetrics.ObservePlacement(0.01)
	nilMetrics.IncPlacementFailure("none")
	nilMetrics.ObserveVMCreate(0.02)
	nilMetrics.ObserveVMSuspend(0.03)
	nilMetrics.ObserveVMResume(0.04)
	nilMetrics.ObserveVMDelete(0.05)
	nilMetrics.SetActiveVMs("workspace", 1)
	nilMetrics.UpdateHostMetrics("host-nil", 0.1, 0.2, 0.3, 4, true)
	nilMetrics.ObserveGuestExec(0.06)
	nilMetrics.ObserveGuestReadiness(0.07)
	nilMetrics.ObserveGuestSnapshotHook(0.08)
	nilMetrics.IncSSHAuthFailure()
	nilMetrics.ObserveSSHTunnel(1.0)
	nilMetrics.ObservePreviewWake(0.09)
	nilMetrics.IncPreviewProxyError()
	nilMetrics.ObserveSnapshotCreate(0.1)
	nilMetrics.ObserveSnapshotLoad(0.11)
	nilMetrics.IncSnapshotCacheHit()
	nilMetrics.IncSnapshotCacheMiss()

	reg := prometheus.NewRegistry()
	metrics := NewSandboxMetrics(reg)
	require.NotNil(t, metrics)
	gathered, err := reg.Gather()
	require.NoError(t, err)
	assert.NotEmpty(t, gathered)

	metrics.ObservePlacement(0.01)
	metrics.IncPlacementFailure("capacity")
	metrics.ObserveVMCreate(0.2)
	metrics.ObserveVMSuspend(0.3)
	metrics.ObserveVMResume(0.4)
	metrics.ObserveVMDelete(0.5)
	metrics.SetActiveVMs("workspace", 7)
	metrics.UpdateHostMetrics("host-healthy", 0.25, 0.5, 0.75, 6, true)
	metrics.UpdateHostMetrics("host-unhealthy", 0.1, 0.2, 0.3, 2, false)
	metrics.ObserveGuestExec(0.6)
	metrics.ObserveGuestReadiness(0.7)
	metrics.ObserveGuestSnapshotHook(0.8)
	metrics.IncSSHAuthFailure()
	metrics.ObserveSSHTunnel(9)
	metrics.ObservePreviewWake(1.2)
	metrics.IncPreviewProxyError()
	metrics.ObserveSnapshotCreate(2.3)
	metrics.ObserveSnapshotLoad(1.7)
	metrics.IncSnapshotCacheHit()
	metrics.IncSnapshotCacheMiss()

	assert.Equal(t, uint64(1), metricsCovHistogramCount(t, metrics.PlacementDurationSeconds))
	assert.Equal(t, uint64(1), metricsCovHistogramCount(t, metrics.VMCreateDurationSeconds))
	assert.Equal(t, uint64(1), metricsCovHistogramCount(t, metrics.VMSuspendDurationSeconds))
	assert.Equal(t, uint64(1), metricsCovHistogramCount(t, metrics.VMResumeDurationSeconds))
	assert.Equal(t, uint64(1), metricsCovHistogramCount(t, metrics.VMDeleteDurationSeconds))
	assert.Equal(t, uint64(1), metricsCovHistogramCount(t, metrics.GuestExecDurationSeconds))
	assert.Equal(t, uint64(1), metricsCovHistogramCount(t, metrics.GuestReadinessDurationSeconds))
	assert.Equal(t, uint64(1), metricsCovHistogramCount(t, metrics.GuestSnapshotHookDurationSeconds))
	assert.Equal(t, uint64(1), metricsCovHistogramCount(t, metrics.SSHTunnelDurationSeconds))
	assert.Equal(t, uint64(1), metricsCovHistogramCount(t, metrics.PreviewWakeDurationSeconds))
	assert.Equal(t, uint64(1), metricsCovHistogramCount(t, metrics.SnapshotCreateDurationSeconds))
	assert.Equal(t, uint64(1), metricsCovHistogramCount(t, metrics.SnapshotLoadDurationSeconds))

	assert.Equal(t, float64(1), testutil.ToFloat64(metrics.PlacementFailuresTotal.WithLabelValues("capacity")))
	assert.Equal(t, float64(7), testutil.ToFloat64(metrics.ActiveVMs.WithLabelValues("workspace")))
	assert.Equal(t, float64(0.25), testutil.ToFloat64(metrics.HostCPUAllocatedRatio.WithLabelValues("host-healthy")))
	assert.Equal(t, float64(0.5), testutil.ToFloat64(metrics.HostMemoryAllocatedRatio.WithLabelValues("host-healthy")))
	assert.Equal(t, float64(0.75), testutil.ToFloat64(metrics.HostDiskAllocatedRatio.WithLabelValues("host-healthy")))
	assert.Equal(t, float64(6), testutil.ToFloat64(metrics.HostVMCount.WithLabelValues("host-healthy")))
	assert.Equal(t, float64(1), testutil.ToFloat64(metrics.HostState.WithLabelValues("host-healthy")))
	assert.Equal(t, float64(0), testutil.ToFloat64(metrics.HostState.WithLabelValues("host-unhealthy")))
	assert.Equal(t, float64(1), testutil.ToFloat64(metrics.SSHAuthFailuresTotal))
	assert.Equal(t, float64(1), testutil.ToFloat64(metrics.PreviewProxyErrorsTotal))
	assert.Equal(t, float64(1), testutil.ToFloat64(metrics.SnapshotCacheHitTotal))
	assert.Equal(t, float64(1), testutil.ToFloat64(metrics.SnapshotCacheMissTotal))
}

func metricsCovHistogramCount(t *testing.T, histogram prometheus.Histogram) uint64 {
	t.Helper()

	var metric dto.Metric
	require.NoError(t, histogram.Write(&metric))
	return metric.GetHistogram().GetSampleCount()
}
