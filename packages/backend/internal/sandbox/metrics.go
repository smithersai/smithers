package sandbox

import "github.com/prometheus/client_golang/prometheus"

// SandboxMetrics holds all Prometheus metric definitions for the Smithers sandbox VM
// platform. These cover the workspace service, host agent, guest agent, SSH/preview
// gateways, and snapshot subsystem.
//
// Metric names follow the convention: smithers_sandbox_{subsystem}_{name}_{unit}
type SandboxMetrics struct {
	// --- Workspace service metrics ---

	// PlacementDurationSeconds records the time to select a host for a VM.
	PlacementDurationSeconds prometheus.Histogram

	// PlacementFailuresTotal counts placement failures by reason.
	PlacementFailuresTotal *prometheus.CounterVec

	// VMCreateDurationSeconds records the time to create a sandbox VM.
	VMCreateDurationSeconds prometheus.Histogram

	// VMSuspendDurationSeconds records the time to suspend a sandbox VM.
	VMSuspendDurationSeconds prometheus.Histogram

	// VMResumeDurationSeconds records the time to resume a sandbox VM.
	VMResumeDurationSeconds prometheus.Histogram

	// VMDeleteDurationSeconds records the time to delete a sandbox VM.
	VMDeleteDurationSeconds prometheus.Histogram

	// ActiveVMs tracks the current number of active VMs by kind (workspace/preview/agent).
	ActiveVMs *prometheus.GaugeVec

	// --- Host agent metrics (reported via heartbeat) ---

	// HostCPUAllocatedRatio tracks the fraction of CPU allocated on each host.
	HostCPUAllocatedRatio *prometheus.GaugeVec

	// HostMemoryAllocatedRatio tracks the fraction of memory allocated on each host.
	HostMemoryAllocatedRatio *prometheus.GaugeVec

	// HostDiskAllocatedRatio tracks the fraction of disk allocated on each host.
	HostDiskAllocatedRatio *prometheus.GaugeVec

	// HostVMCount tracks the number of VMs running on each host.
	HostVMCount *prometheus.GaugeVec

	// HostState tracks host health: 1 for healthy, 0 for unhealthy.
	HostState *prometheus.GaugeVec

	// --- Guest agent metrics ---

	// GuestExecDurationSeconds records command execution time inside a guest.
	GuestExecDurationSeconds prometheus.Histogram

	// GuestReadinessDurationSeconds records time until a guest reports ready.
	GuestReadinessDurationSeconds prometheus.Histogram

	// GuestSnapshotHookDurationSeconds records snapshot hook execution time.
	GuestSnapshotHookDurationSeconds prometheus.Histogram

	// --- Gateway metrics ---

	// SSHAuthFailuresTotal counts SSH authentication failures.
	SSHAuthFailuresTotal prometheus.Counter

	// SSHTunnelDurationSeconds records the duration of SSH tunnel sessions.
	SSHTunnelDurationSeconds prometheus.Histogram

	// PreviewWakeDurationSeconds records time to wake a suspended preview environment.
	PreviewWakeDurationSeconds prometheus.Histogram

	// PreviewProxyErrorsTotal counts preview proxy errors.
	PreviewProxyErrorsTotal prometheus.Counter

	// --- Snapshot metrics ---

	// SnapshotCreateDurationSeconds records snapshot creation time.
	SnapshotCreateDurationSeconds prometheus.Histogram

	// SnapshotLoadDurationSeconds records snapshot load time.
	SnapshotLoadDurationSeconds prometheus.Histogram

	// SnapshotCacheHitTotal counts snapshot cache hits.
	SnapshotCacheHitTotal prometheus.Counter

	// SnapshotCacheMissTotal counts snapshot cache misses.
	SnapshotCacheMissTotal prometheus.Counter
}

// NewSandboxMetrics creates a new SandboxMetrics instance and registers all
// metrics with the provided Prometheus registerer. Pass nil to skip registration
// (useful for tests that only need the struct).
func NewSandboxMetrics(reg prometheus.Registerer) *SandboxMetrics {
	m := &SandboxMetrics{
		// --- Workspace service ---
		PlacementDurationSeconds: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "smithers_sandbox_placement_duration_seconds",
			Help:    "Time to select a host for a sandbox VM.",
			Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2},
		}),
		PlacementFailuresTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "smithers_sandbox_placement_failures_total",
			Help: "Total sandbox VM placement failures, labeled by reason.",
		}, []string{"reason"}),
		VMCreateDurationSeconds: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "smithers_sandbox_vm_create_duration_seconds",
			Help:    "Time to create a sandbox VM.",
			Buckets: []float64{0.1, 0.25, 0.5, 1, 2, 5, 10, 30},
		}),
		VMSuspendDurationSeconds: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "smithers_sandbox_vm_suspend_duration_seconds",
			Help:    "Time to suspend a sandbox VM.",
			Buckets: []float64{0.05, 0.1, 0.25, 0.5, 1, 2, 5},
		}),
		VMResumeDurationSeconds: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "smithers_sandbox_vm_resume_duration_seconds",
			Help:    "Time to resume a sandbox VM.",
			Buckets: []float64{0.05, 0.1, 0.25, 0.5, 1, 2, 5},
		}),
		VMDeleteDurationSeconds: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "smithers_sandbox_vm_delete_duration_seconds",
			Help:    "Time to delete a sandbox VM.",
			Buckets: []float64{0.05, 0.1, 0.25, 0.5, 1, 2, 5},
		}),
		ActiveVMs: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "smithers_sandbox_active_vms",
			Help: "Number of active sandbox VMs by kind.",
		}, []string{"kind"}),

		// --- Host agent ---
		HostCPUAllocatedRatio: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "smithers_sandbox_host_cpu_allocated_ratio",
			Help: "Fraction of CPU allocated on a sandbox host (0.0-1.0).",
		}, []string{"host"}),
		HostMemoryAllocatedRatio: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "smithers_sandbox_host_memory_allocated_ratio",
			Help: "Fraction of memory allocated on a sandbox host (0.0-1.0).",
		}, []string{"host"}),
		HostDiskAllocatedRatio: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "smithers_sandbox_host_disk_allocated_ratio",
			Help: "Fraction of disk allocated on a sandbox host (0.0-1.0).",
		}, []string{"host"}),
		HostVMCount: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "smithers_sandbox_host_vm_count",
			Help: "Number of VMs running on a sandbox host.",
		}, []string{"host"}),
		HostState: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "smithers_sandbox_host_state",
			Help: "sandbox host health state: 1 = healthy, 0 = unhealthy.",
		}, []string{"host"}),

		// --- Guest agent ---
		GuestExecDurationSeconds: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "smithers_sandbox_guest_exec_duration_seconds",
			Help:    "Duration of command execution inside a guest VM.",
			Buckets: []float64{0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300},
		}),
		GuestReadinessDurationSeconds: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "smithers_sandbox_guest_readiness_duration_seconds",
			Help:    "Time until a guest VM reports ready after creation or resume.",
			Buckets: []float64{0.1, 0.25, 0.5, 1, 2, 5, 10, 30},
		}),
		GuestSnapshotHookDurationSeconds: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "smithers_sandbox_guest_snapshot_hook_duration_seconds",
			Help:    "Duration of pre/post snapshot hooks inside a guest VM.",
			Buckets: []float64{0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5},
		}),

		// --- Gateway ---
		SSHAuthFailuresTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "smithers_sandbox_ssh_auth_failures_total",
			Help: "Total SSH gateway authentication failures.",
		}),
		SSHTunnelDurationSeconds: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "smithers_sandbox_ssh_tunnel_duration_seconds",
			Help:    "Duration of SSH tunnel sessions through the gateway.",
			Buckets: []float64{1, 5, 30, 60, 300, 600, 1800, 3600},
		}),
		PreviewWakeDurationSeconds: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "smithers_sandbox_preview_wake_duration_seconds",
			Help:    "Time to wake a suspended preview environment.",
			Buckets: []float64{0.1, 0.25, 0.5, 1, 2, 5, 10, 30},
		}),
		PreviewProxyErrorsTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "smithers_sandbox_preview_proxy_errors_total",
			Help: "Total preview proxy errors.",
		}),

		// --- Snapshot ---
		SnapshotCreateDurationSeconds: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "smithers_sandbox_snapshot_create_duration_seconds",
			Help:    "Duration of snapshot creation.",
			Buckets: []float64{0.1, 0.5, 1, 2, 5, 10, 30, 60},
		}),
		SnapshotLoadDurationSeconds: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "smithers_sandbox_snapshot_load_duration_seconds",
			Help:    "Duration of snapshot loading.",
			Buckets: []float64{0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10},
		}),
		SnapshotCacheHitTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "smithers_sandbox_snapshot_cache_hit_total",
			Help: "Total snapshot cache hits.",
		}),
		SnapshotCacheMissTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "smithers_sandbox_snapshot_cache_miss_total",
			Help: "Total snapshot cache misses.",
		}),
	}

	if reg != nil {
		reg.MustRegister(
			// Workspace service
			m.PlacementDurationSeconds,
			m.PlacementFailuresTotal,
			m.VMCreateDurationSeconds,
			m.VMSuspendDurationSeconds,
			m.VMResumeDurationSeconds,
			m.VMDeleteDurationSeconds,
			m.ActiveVMs,
			// Host agent
			m.HostCPUAllocatedRatio,
			m.HostMemoryAllocatedRatio,
			m.HostDiskAllocatedRatio,
			m.HostVMCount,
			m.HostState,
			// Guest agent
			m.GuestExecDurationSeconds,
			m.GuestReadinessDurationSeconds,
			m.GuestSnapshotHookDurationSeconds,
			// Gateway
			m.SSHAuthFailuresTotal,
			m.SSHTunnelDurationSeconds,
			m.PreviewWakeDurationSeconds,
			m.PreviewProxyErrorsTotal,
			// Snapshot
			m.SnapshotCreateDurationSeconds,
			m.SnapshotLoadDurationSeconds,
			m.SnapshotCacheHitTotal,
			m.SnapshotCacheMissTotal,
		)
	}

	return m
}

// --- Workspace service helpers ---

// ObservePlacement records a successful host placement duration.
func (m *SandboxMetrics) ObservePlacement(seconds float64) {
	if m == nil {
		return
	}
	m.PlacementDurationSeconds.Observe(seconds)
}

// IncPlacementFailure records a placement failure with the given reason.
func (m *SandboxMetrics) IncPlacementFailure(reason string) {
	if m == nil {
		return
	}
	m.PlacementFailuresTotal.WithLabelValues(reason).Inc()
}

// ObserveVMCreate records VM creation duration.
func (m *SandboxMetrics) ObserveVMCreate(seconds float64) {
	if m == nil {
		return
	}
	m.VMCreateDurationSeconds.Observe(seconds)
}

// ObserveVMSuspend records VM suspend duration.
func (m *SandboxMetrics) ObserveVMSuspend(seconds float64) {
	if m == nil {
		return
	}
	m.VMSuspendDurationSeconds.Observe(seconds)
}

// ObserveVMResume records VM resume duration.
func (m *SandboxMetrics) ObserveVMResume(seconds float64) {
	if m == nil {
		return
	}
	m.VMResumeDurationSeconds.Observe(seconds)
}

// ObserveVMDelete records VM deletion duration.
func (m *SandboxMetrics) ObserveVMDelete(seconds float64) {
	if m == nil {
		return
	}
	m.VMDeleteDurationSeconds.Observe(seconds)
}

// SetActiveVMs updates the active VM gauge for a given kind.
func (m *SandboxMetrics) SetActiveVMs(kind string, n float64) {
	if m == nil {
		return
	}
	m.ActiveVMs.WithLabelValues(kind).Set(n)
}

// --- Host agent helpers ---

// UpdateHostMetrics sets all resource allocation gauges for a single host,
// typically called when processing a heartbeat from the host agent.
func (m *SandboxMetrics) UpdateHostMetrics(host string, cpuRatio, memRatio, diskRatio float64, vmCount int, healthy bool) {
	if m == nil {
		return
	}
	m.HostCPUAllocatedRatio.WithLabelValues(host).Set(cpuRatio)
	m.HostMemoryAllocatedRatio.WithLabelValues(host).Set(memRatio)
	m.HostDiskAllocatedRatio.WithLabelValues(host).Set(diskRatio)
	m.HostVMCount.WithLabelValues(host).Set(float64(vmCount))
	if healthy {
		m.HostState.WithLabelValues(host).Set(1)
	} else {
		m.HostState.WithLabelValues(host).Set(0)
	}
}

// --- Guest agent helpers ---

// ObserveGuestExec records command execution duration inside a guest.
func (m *SandboxMetrics) ObserveGuestExec(seconds float64) {
	if m == nil {
		return
	}
	m.GuestExecDurationSeconds.Observe(seconds)
}

// ObserveGuestReadiness records guest readiness time.
func (m *SandboxMetrics) ObserveGuestReadiness(seconds float64) {
	if m == nil {
		return
	}
	m.GuestReadinessDurationSeconds.Observe(seconds)
}

// ObserveGuestSnapshotHook records snapshot hook execution time.
func (m *SandboxMetrics) ObserveGuestSnapshotHook(seconds float64) {
	if m == nil {
		return
	}
	m.GuestSnapshotHookDurationSeconds.Observe(seconds)
}

// --- Gateway helpers ---

// IncSSHAuthFailure records an SSH gateway authentication failure.
func (m *SandboxMetrics) IncSSHAuthFailure() {
	if m == nil {
		return
	}
	m.SSHAuthFailuresTotal.Inc()
}

// ObserveSSHTunnel records the duration of an SSH tunnel session.
func (m *SandboxMetrics) ObserveSSHTunnel(seconds float64) {
	if m == nil {
		return
	}
	m.SSHTunnelDurationSeconds.Observe(seconds)
}

// ObservePreviewWake records the time to wake a preview environment.
func (m *SandboxMetrics) ObservePreviewWake(seconds float64) {
	if m == nil {
		return
	}
	m.PreviewWakeDurationSeconds.Observe(seconds)
}

// IncPreviewProxyError records a preview proxy error.
func (m *SandboxMetrics) IncPreviewProxyError() {
	if m == nil {
		return
	}
	m.PreviewProxyErrorsTotal.Inc()
}

// --- Snapshot helpers ---

// ObserveSnapshotCreate records snapshot creation duration.
func (m *SandboxMetrics) ObserveSnapshotCreate(seconds float64) {
	if m == nil {
		return
	}
	m.SnapshotCreateDurationSeconds.Observe(seconds)
}

// ObserveSnapshotLoad records snapshot load duration.
func (m *SandboxMetrics) ObserveSnapshotLoad(seconds float64) {
	if m == nil {
		return
	}
	m.SnapshotLoadDurationSeconds.Observe(seconds)
}

// IncSnapshotCacheHit records a snapshot cache hit.
func (m *SandboxMetrics) IncSnapshotCacheHit() {
	if m == nil {
		return
	}
	m.SnapshotCacheHitTotal.Inc()
}

// IncSnapshotCacheMiss records a snapshot cache miss.
func (m *SandboxMetrics) IncSnapshotCacheMiss() {
	if m == nil {
		return
	}
	m.SnapshotCacheMissTotal.Inc()
}
