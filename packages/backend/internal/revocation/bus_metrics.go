package revocation

import "github.com/prometheus/client_golang/prometheus"

// busMetrics makes a stalled or unpositioned bus visible. A pod whose bus is
// not positioned, not connected, or not advancing its cursor stops
// terminating revoked streams without any other signal.
type busMetrics struct {
	eventsApplied *prometheus.CounterVec
	catchUpErrors prometheus.Counter
	reconnects    prometheus.Counter
}

func newBusMetrics() busMetrics {
	return busMetrics{
		eventsApplied: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "smithers_revocation_events_applied_total",
			Help: "Revocation events applied by this process's bus, by kind.",
		}, []string{"kind"}),
		catchUpErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "smithers_revocation_catchup_errors_total",
			Help: "Failed reads of the revocation event log (cursor position or catch-up).",
		}),
		reconnects: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "smithers_revocation_reconnects_total",
			Help: "Revocation LISTEN connections lost or never acquired, each followed by a retry.",
		}),
	}
}

// MetricsCollectors returns the bus's Prometheus collectors for registration
// on the Smithers metrics registry.
func (b *Bus) MetricsCollectors() []prometheus.Collector {
	if b == nil {
		return nil
	}
	return []prometheus.Collector{
		b.metrics.eventsApplied,
		b.metrics.catchUpErrors,
		b.metrics.reconnects,
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: "smithers_revocation_bus_positioned",
			Help: "1 once the bus has read its starting cursor from the event log.",
		}, func() float64 { return boolGauge(b.Positioned()) }),
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: "smithers_revocation_bus_connected",
			Help: "1 while the bus holds a LISTEN connection.",
		}, func() float64 { return boolGauge(b.connectedNow()) }),
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: "smithers_revocation_bus_cursor",
			Help: "Highest revocation event ID this process has read. Compare with the database max ID for lag.",
		}, func() float64 { return float64(b.Cursor()) }),
	}
}

func (b *Bus) connectedNow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.connected
}

func (b *Bus) setConnected(connected bool) {
	b.mu.Lock()
	b.connected = connected
	b.mu.Unlock()
}

func boolGauge(v bool) float64 {
	if v {
		return 1
	}
	return 0
}
