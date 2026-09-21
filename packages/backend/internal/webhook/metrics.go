package webhook

const (
	DeliveryOutcomeSuccess  = "success"
	DeliveryOutcomeRetry    = "retry"
	DeliveryOutcomeFailed   = "failed"
	DeliveryOutcomeDisabled = "disabled"
)

// MetricsObserver records webhook delivery attempt and terminal outcome metrics.
type MetricsObserver interface {
	ObserveWebhookDeliveryAttempt(outcome string)
	ObserveWebhookDeliveryTerminal(outcome string)
}

func observeWebhookDeliveryAttempt(observer MetricsObserver, outcome string) {
	if observer == nil {
		return
	}
	observer.ObserveWebhookDeliveryAttempt(outcome)
}

func observeWebhookDeliveryTerminal(observer MetricsObserver, outcome string) {
	if observer == nil {
		return
	}
	observer.ObserveWebhookDeliveryTerminal(outcome)
}
