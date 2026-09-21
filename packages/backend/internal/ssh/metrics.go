package ssh

import "github.com/prometheus/client_golang/prometheus"

// Metrics holds all Prometheus metric definitions for the SSH server.
// Metric names follow the spec in docs/specs/infra.md:
// smithers_ssh_{name}_{unit}
type Metrics struct {
	// AuthAttempts counts SSH authentication attempts by result.
	AuthAttempts *prometheus.CounterVec

	// ActiveConns tracks the number of currently active SSH connections.
	ActiveConns prometheus.Gauge

	// GitOperations counts completed git operations by command and result.
	GitOperations *prometheus.CounterVec

	// GitOpDuration records the duration of git operations as a histogram.
	GitOpDuration *prometheus.HistogramVec
}

// NewMetrics creates a new Metrics instance and registers all metrics
// with the provided Prometheus registerer.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		AuthAttempts: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "smithers_ssh_auth_attempts_total",
			Help: "Total SSH authentication attempts",
		}, []string{"result"}), // success, failed, banned, throttled
		ActiveConns: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "smithers_ssh_active_connections",
			Help: "Currently active SSH connections",
		}),
		GitOperations: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "smithers_ssh_git_operations_total",
			Help: "Total git operations via SSH",
		}, []string{"command", "result"}), // command: receive-pack/upload-pack, result: success/error
		GitOpDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "smithers_ssh_git_operation_duration_seconds",
			Help:    "Duration of git operations via SSH",
			Buckets: prometheus.DefBuckets,
		}, []string{"command"}),
	}
	reg.MustRegister(m.AuthAttempts, m.ActiveConns, m.GitOperations, m.GitOpDuration)
	return m
}
