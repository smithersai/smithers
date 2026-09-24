package previewgateway

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Request outcomes. Each preview request records exactly one.
const (
	outcomeServed        = "served"
	outcomeUnauthorized  = "unauthorized"
	outcomeNotFound      = "not_found"
	outcomeUnavailable   = "unavailable"
	outcomeUpstreamError = "upstream_error"
)

// Metrics counts preview requests and their latency by outcome, so a relay
// token that refuses every platform domain shows up as an unauthorized spike
// instead of user reports.
type Metrics struct {
	requests *prometheus.CounterVec
	latency  *prometheus.HistogramVec
}

// NewMetrics builds the gateway metrics and registers them when registerer is
// non-nil.
func NewMetrics(registerer prometheus.Registerer) *Metrics {
	metrics := &Metrics{
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "plue_preview_gateway_requests_total",
			Help: "Preview gateway requests by outcome.",
		}, []string{"outcome"}),
		latency: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "plue_preview_gateway_request_duration_seconds",
			Help:    "Preview gateway request latency by outcome.",
			Buckets: prometheus.DefBuckets,
		}, []string{"outcome"}),
	}
	if registerer != nil {
		registerer.MustRegister(metrics.requests, metrics.latency)
	}
	return metrics
}

func (metrics *Metrics) observe(outcome string, elapsed time.Duration) {
	if metrics == nil {
		return
	}
	metrics.requests.WithLabelValues(outcome).Inc()
	metrics.latency.WithLabelValues(outcome).Observe(elapsed.Seconds())
}
