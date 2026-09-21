package webhook

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

type mockMetricsObserver struct {
	attemptCalls  []string
	terminalCalls []string
}

func (m *mockMetricsObserver) ObserveWebhookDeliveryAttempt(outcome string) {
	m.attemptCalls = append(m.attemptCalls, outcome)
}

func (m *mockMetricsObserver) ObserveWebhookDeliveryTerminal(outcome string) {
	m.terminalCalls = append(m.terminalCalls, outcome)
}

func TestObserveWebhookDeliveryAttempt_NilObserver(t *testing.T) {
	t.Parallel()

	// Should not panic
	observeWebhookDeliveryAttempt(nil, DeliveryOutcomeSuccess)
}

func TestObserveWebhookDeliveryAttempt_RecordsOutcome(t *testing.T) {
	t.Parallel()

	obs := &mockMetricsObserver{}
	observeWebhookDeliveryAttempt(obs, DeliveryOutcomeSuccess)

	assert.Equal(t, []string{DeliveryOutcomeSuccess}, obs.attemptCalls)
}

func TestObserveWebhookDeliveryTerminal_NilObserver(t *testing.T) {
	t.Parallel()

	// Should not panic
	observeWebhookDeliveryTerminal(nil, DeliveryOutcomeFailed)
}

func TestObserveWebhookDeliveryTerminal_RecordsOutcome(t *testing.T) {
	t.Parallel()

	obs := &mockMetricsObserver{}
	observeWebhookDeliveryTerminal(obs, DeliveryOutcomeFailed)

	assert.Equal(t, []string{DeliveryOutcomeFailed}, obs.terminalCalls)
}

func TestObserveWebhookDeliveryAttempt_MultipleOutcomes(t *testing.T) {
	t.Parallel()

	obs := &mockMetricsObserver{}
	observeWebhookDeliveryAttempt(obs, DeliveryOutcomeSuccess)
	observeWebhookDeliveryAttempt(obs, DeliveryOutcomeRetry)
	observeWebhookDeliveryAttempt(obs, DeliveryOutcomeFailed)

	assert.Equal(t, []string{DeliveryOutcomeSuccess, DeliveryOutcomeRetry, DeliveryOutcomeFailed}, obs.attemptCalls)
}

func TestDeliveryOutcomeConstants(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "success", DeliveryOutcomeSuccess)
	assert.Equal(t, "retry", DeliveryOutcomeRetry)
	assert.Equal(t, "failed", DeliveryOutcomeFailed)
	assert.Equal(t, "disabled", DeliveryOutcomeDisabled)
}
