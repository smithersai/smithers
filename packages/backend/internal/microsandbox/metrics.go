package microsandbox

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
)

// Metrics contains bounded-label telemetry shared by the controller and
// workers. Resource IDs, commands, domains, repositories, and secret-bearing
// payloads are deliberately never metric labels.
type Metrics struct {
	requests           *prometheus.CounterVec
	requestLatency     *prometheus.HistogramVec
	activeStreams      *prometheus.GaugeVec
	streamDuration     *prometheus.HistogramVec
	reconcile          *prometheus.CounterVec
	reconcileError     prometheus.Counter
	reconcileLast      prometheus.Gauge
	hostStates         *prometheus.GaugeVec
	capacity           *prometheus.GaugeVec
	instanceStates     *prometheus.GaugeVec
	orphans            prometheus.Gauge
	cleanupPending     prometheus.Gauge
	workerLease        *prometheus.GaugeVec
	inventory          *prometheus.GaugeVec
	heartbeatError     prometheus.Counter
	egressAuditDropped *prometheus.CounterVec
	workerDiskUsage    prometheus.Gauge
}

var (
	controllerHostStates     = []string{"ready", "draining", "stale", "fenced"}
	controllerInstanceStates = []string{
		"starting", "running", "stopping", "stopped", "restart_pending",
		"recovering", "deleting", "degraded", "failed",
	}
)

func NewMetrics(registerer prometheus.Registerer) *Metrics {
	metrics := &Metrics{
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "plue_microsandbox_requests_total",
			Help: "Microsandbox API requests by component, bounded route, method, and result class.",
		}, []string{"component", "operation", "method", "result"}),
		requestLatency: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "plue_microsandbox_request_duration_seconds",
			Help:    "Microsandbox API request latency by component and bounded operation.",
			Buckets: []float64{0.005, 0.025, 0.1, 0.5, 1, 5, 15, 60, 300, 1800},
		}, []string{"component", "operation", "method", "result"}),
		activeStreams: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "plue_microsandbox_active_streams",
			Help: "Active SSH or preview streams.",
		}, []string{"component", "kind"}),
		streamDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "plue_microsandbox_stream_duration_seconds",
			Help:    "Duration of completed SSH or preview streams.",
			Buckets: []float64{1, 5, 30, 60, 300, 900, 3600, 14400},
		}, []string{"component", "kind"}),
		reconcile: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "plue_microsandbox_reconcile_actions_total",
			Help: "Controller reconciliation outcomes by bounded action.",
		}, []string{"action"}),
		reconcileError: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "plue_microsandbox_reconcile_errors_total",
			Help: "Controller reconciliation cycles that ended with an error.",
		}),
		reconcileLast: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "plue_microsandbox_reconcile_last_success_timestamp_seconds",
			Help: "Unix timestamp of the last controller reconciliation cycle that completed without error.",
		}),
		hostStates: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "plue_microsandbox_hosts",
			Help: "Registered sandbox hosts by controller state.",
		}, []string{"state"}),
		capacity: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "plue_microsandbox_capacity",
			Help: "Aggregate worker capacity by resource and accounting kind.",
		}, []string{"resource", "kind"}),
		instanceStates: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "plue_microsandbox_instances",
			Help: "Sandbox instances by observed lifecycle state.",
		}, []string{"state"}),
		orphans: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "plue_microsandbox_orphans",
			Help: "Worker runtime entries currently quarantined as orphans.",
		}),
		cleanupPending: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "plue_microsandbox_cleanup_pending",
			Help: "Sandbox instances awaiting provider cleanup convergence.",
		}),
		workerLease: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "plue_microsandbox_worker_lease",
			Help: "Local worker controller lease state (1 active, 0 inactive).",
		}, []string{"state"}),
		inventory: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "plue_microsandbox_worker_inventory",
			Help: "Local worker runtime inventory by observed state.",
		}, []string{"state"}),
		heartbeatError: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "plue_microsandbox_worker_heartbeat_errors_total",
			Help: "Worker heartbeat attempts that failed authorization or transport.",
		}),
		egressAuditDropped: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "plue_microsandbox_egress_audit_dropped_total",
			Help: "Sandbox egress audit records dropped by bounded reason.",
		}, []string{"reason"}),
		workerDiskUsage: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "plue_microsandbox_worker_disk_usage_ratio",
			Help: "Physical utilization ratio of the node filesystem backing Microsandbox worker state.",
		}),
	}
	if registerer != nil {
		registerer.MustRegister(
			metrics.requests, metrics.requestLatency, metrics.activeStreams,
			metrics.streamDuration, metrics.reconcile, metrics.reconcileError,
			metrics.reconcileLast, metrics.hostStates,
			metrics.capacity, metrics.instanceStates, metrics.orphans,
			metrics.cleanupPending, metrics.workerLease, metrics.inventory,
			metrics.heartbeatError, metrics.egressAuditDropped, metrics.workerDiskUsage,
		)
	}
	// Materialize every bounded placement-state series immediately. This makes
	// the controller export the gauge descriptors even if its first database
	// refresh fails, and it prevents absent-series PromQL from hiding a genuine
	// zero-ready-host condition during startup.
	metrics.SetHostStates(nil)
	metrics.SetInstanceStates(nil)
	return metrics
}

func (metrics *Metrics) SetWorkerDiskUsage(ratio float64) {
	if metrics != nil {
		metrics.workerDiskUsage.Set(ratio)
	}
}

type metricResponseWriter struct {
	http.ResponseWriter
	status int
}

func (writer *metricResponseWriter) Unwrap() http.ResponseWriter { return writer.ResponseWriter }
func (writer *metricResponseWriter) WriteHeader(status int) {
	if writer.status == 0 {
		writer.status = status
	}
	writer.ResponseWriter.WriteHeader(status)
}
func (writer *metricResponseWriter) Write(payload []byte) (int, error) {
	if writer.status == 0 {
		writer.status = http.StatusOK
	}
	return writer.ResponseWriter.Write(payload)
}

func (metrics *Metrics) Instrument(component string, next http.Handler) http.Handler {
	if metrics == nil {
		return next
	}
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		started := time.Now()
		streamKind := requestStreamKind(request)
		if streamKind != "" {
			metrics.activeStreams.WithLabelValues(component, streamKind).Inc()
			defer func() {
				metrics.activeStreams.WithLabelValues(component, streamKind).Dec()
				metrics.streamDuration.WithLabelValues(component, streamKind).Observe(time.Since(started).Seconds())
			}()
		}
		recorder := &metricResponseWriter{ResponseWriter: writer}
		next.ServeHTTP(recorder, request)
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		operation := chi.RouteContext(request.Context()).RoutePattern()
		if operation == "" {
			operation = "unmatched"
		}
		result := strconv.Itoa(status/100) + "xx"
		labels := []string{component, operation, request.Method, result}
		metrics.requests.WithLabelValues(labels...).Inc()
		metrics.requestLatency.WithLabelValues(labels...).Observe(time.Since(started).Seconds())
	})
}

func requestStreamKind(request *http.Request) string {
	if !strings.EqualFold(strings.TrimSpace(request.Header.Get("Upgrade")), "websocket") {
		return ""
	}
	switch {
	case strings.Contains(request.URL.Path, "/ssh"):
		return "ssh"
	case strings.Contains(request.URL.Path, "/preview"):
		return "preview"
	default:
		return "other"
	}
}

func (metrics *Metrics) AddReconcile(action string, value int64) {
	if metrics != nil && value > 0 {
		metrics.reconcile.WithLabelValues(action).Add(float64(value))
	}
}

func (metrics *Metrics) ObserveReconcile(success bool, at time.Time) {
	if metrics == nil {
		return
	}
	if !success {
		metrics.reconcileError.Inc()
		return
	}
	metrics.reconcileLast.Set(float64(at.Unix()))
}

func (metrics *Metrics) SetHostStates(states map[string]float64) {
	if metrics == nil {
		return
	}
	for _, state := range controllerHostStates {
		metrics.hostStates.WithLabelValues(state).Set(states[state])
	}
}

func (metrics *Metrics) SetCapacity(resource, kind string, value float64) {
	if metrics != nil {
		metrics.capacity.WithLabelValues(resource, kind).Set(value)
	}
}

func (metrics *Metrics) SetInstanceStates(states map[string]float64) {
	if metrics == nil {
		return
	}
	for _, state := range controllerInstanceStates {
		metrics.instanceStates.WithLabelValues(state).Set(states[state])
	}
}

func (metrics *Metrics) SetOrphans(value float64) {
	if metrics != nil {
		metrics.orphans.Set(value)
	}
}

func (metrics *Metrics) SetCleanupPending(value float64) {
	if metrics != nil {
		metrics.cleanupPending.Set(value)
	}
}

func (metrics *Metrics) ObserveWorkerHeartbeat(authorized, admitNew bool, capacity, allocated WorkerCapacity, inventory []WorkerInventoryItem) {
	if metrics == nil {
		return
	}
	metrics.workerLease.WithLabelValues("authorized").Set(boolFloat(authorized))
	metrics.workerLease.WithLabelValues("admit_new").Set(boolFloat(admitNew))
	for resource, values := range map[string][2]float64{
		"cpu_millis":   {float64(capacity.CPUMillis), float64(allocated.CPUMillis)},
		"memory_bytes": {float64(capacity.MemoryBytes), float64(allocated.MemoryBytes)},
		"disk_bytes":   {float64(capacity.DiskBytes), float64(allocated.DiskBytes)},
		"vms":          {float64(capacity.VMs), float64(allocated.VMs)},
	} {
		metrics.capacity.WithLabelValues(resource, "total").Set(values[0])
		metrics.capacity.WithLabelValues(resource, "observed").Set(values[1])
	}
	counts := map[string]float64{}
	for _, item := range inventory {
		state := item.State
		if state == "" {
			state = "unknown"
		}
		counts[state]++
	}
	for _, state := range []string{"starting", "running", "stopped", "restart_pending", "unknown"} {
		metrics.inventory.WithLabelValues(state).Set(counts[state])
	}
}

func (metrics *Metrics) IncHeartbeatError() {
	if metrics != nil {
		metrics.heartbeatError.Inc()
	}
}

func (metrics *Metrics) IncEgressAuditDropped(reason string) {
	if metrics == nil {
		return
	}
	switch reason {
	case "backpressure", "delivery", "controller_rejected":
	default:
		reason = "other"
	}
	metrics.egressAuditDropped.WithLabelValues(reason).Inc()
}

func boolFloat(value bool) float64 {
	if value {
		return 1
	}
	return 0
}
