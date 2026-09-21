package routes

import "github.com/prometheus/client_golang/prometheus"

// WebhookMetrics holds Prometheus metrics for webhook delivery tracking.
type WebhookMetrics struct {
	// DeliveryAttemptsTotal counts webhook delivery attempts by outcome.
	DeliveryAttemptsTotal *prometheus.CounterVec

	// DeliveryTerminalOutcomesTotal counts terminal webhook delivery outcomes.
	DeliveryTerminalOutcomesTotal *prometheus.CounterVec
}

// NewWebhookMetrics creates a new WebhookMetrics instance and registers all
// metrics with the provided Prometheus registerer. Pass nil to skip registration.
func NewWebhookMetrics(reg prometheus.Registerer) *WebhookMetrics {
	m := &WebhookMetrics{
		DeliveryAttemptsTotal: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "smithers_webhook_delivery_attempts_total",
				Help: "Total webhook delivery attempts, labeled by outcome.",
			},
			[]string{"outcome"},
		),
		DeliveryTerminalOutcomesTotal: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "smithers_webhook_delivery_terminal_outcomes_total",
				Help: "Total terminal webhook delivery outcomes, labeled by outcome.",
			},
			[]string{"outcome"},
		),
	}

	if reg != nil {
		reg.MustRegister(
			m.DeliveryAttemptsTotal,
			m.DeliveryTerminalOutcomesTotal,
		)
	}

	return m
}
