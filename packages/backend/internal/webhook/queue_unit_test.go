package webhook

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockQueueStore struct {
	claimFn        func(ctx context.Context, limit int32) ([]db.WebhookDelivery, error)
	listWebhooksFn func(ctx context.Context, ids []int64) ([]db.Webhook, error)
	updateResultFn func(ctx context.Context, arg db.UpdateWebhookDeliveryResultParams) error
	updateRetryFn  func(ctx context.Context, arg db.UpdateWebhookDeliveryRetryParams) error
	listStatusFn   func(ctx context.Context, webhookID int64) ([]string, error)
	setActiveFn    func(ctx context.Context, arg db.SetWebhookActiveParams) error
}

type fakeWebhookMetricsObserver struct {
	attempts []string
	terminal []string
}

func (f *fakeWebhookMetricsObserver) ObserveWebhookDeliveryAttempt(outcome string) {
	f.attempts = append(f.attempts, outcome)
}

func (f *fakeWebhookMetricsObserver) ObserveWebhookDeliveryTerminal(outcome string) {
	f.terminal = append(f.terminal, outcome)
}

func (m *mockQueueStore) ClaimDueWebhookDeliveries(ctx context.Context, limit int32) ([]db.WebhookDelivery, error) {
	if m.claimFn != nil {
		return m.claimFn(ctx, limit)
	}
	return nil, nil
}

func (m *mockQueueStore) ListWebhooksByIDs(ctx context.Context, ids []int64) ([]db.Webhook, error) {
	if m.listWebhooksFn != nil {
		return m.listWebhooksFn(ctx, ids)
	}
	return nil, nil
}

func (m *mockQueueStore) UpdateWebhookDeliveryResult(ctx context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
	if m.updateResultFn != nil {
		return m.updateResultFn(ctx, arg)
	}
	return nil
}

func (m *mockQueueStore) UpdateWebhookDeliveryRetry(ctx context.Context, arg db.UpdateWebhookDeliveryRetryParams) error {
	if m.updateRetryFn != nil {
		return m.updateRetryFn(ctx, arg)
	}
	return nil
}

func (m *mockQueueStore) ListRecentWebhookDeliveryStatuses(ctx context.Context, webhookID int64) ([]string, error) {
	if m.listStatusFn != nil {
		return m.listStatusFn(ctx, webhookID)
	}
	return nil, nil
}

func (m *mockQueueStore) SetWebhookActive(ctx context.Context, arg db.SetWebhookActiveParams) error {
	if m.setActiveFn != nil {
		return m.setActiveFn(ctx, arg)
	}
	return nil
}

func TestUpdateTaskStatus_UsesDeliveryWebhookIDWhenWebhookIsMissing(t *testing.T) {
	t.Parallel()

	var capturedWebhookID int64
	var disabledWebhookID int64
	store := &mockQueueStore{
		updateResultFn: func(_ context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
			assert.Equal(t, "failed", arg.Status)
			return nil
		},
		listStatusFn: func(_ context.Context, webhookID int64) ([]string, error) {
			capturedWebhookID = webhookID
			return []string{
				"failed", "failed", "failed", "failed", "failed",
				"failed", "failed", "failed", "failed", "failed",
			}, nil
		},
		setActiveFn: func(_ context.Context, arg db.SetWebhookActiveParams) error {
			disabledWebhookID = arg.ID
			assert.False(t, arg.IsActive)
			return nil
		},
	}

	err := UpdateTaskStatus(context.Background(), store, Task{
		Delivery: db.WebhookDelivery{
			ID:        101,
			WebhookID: 42,
			Attempts:  4,
		},
		Webhook: db.Webhook{},
	}, DeliveryResult{
		StatusCode:   500,
		ResponseBody: "boom",
		Err:          assert.AnError,
	}, time.Date(2026, time.February, 22, 12, 0, 0, 0, time.UTC), nil)
	require.NoError(t, err)
	assert.Equal(t, int64(42), capturedWebhookID)
	assert.Equal(t, int64(42), disabledWebhookID)
}

func TestPollQueue_BatchesWebhookLookupAndPreservesDeliveryOrder(t *testing.T) {
	t.Parallel()

	var requestedIDs []int64
	store := &mockQueueStore{
		claimFn: func(_ context.Context, _ int32) ([]db.WebhookDelivery, error) {
			return []db.WebhookDelivery{
				{ID: 101, WebhookID: 42},
				{ID: 102, WebhookID: 7},
				{ID: 103, WebhookID: 42},
			}, nil
		},
		listWebhooksFn: func(_ context.Context, ids []int64) ([]db.Webhook, error) {
			requestedIDs = append([]int64(nil), ids...)
			return []db.Webhook{
				{ID: 7, Url: "https://example.com/7"},
				{ID: 42, Url: "https://example.com/42"},
			}, nil
		},
	}

	tasks, err := PollQueue(context.Background(), store, 10)
	require.NoError(t, err)
	require.Len(t, tasks, 3)
	assert.Equal(t, []int64{42, 7}, requestedIDs)
	assert.Equal(t, []int64{101, 102, 103}, []int64{tasks[0].Delivery.ID, tasks[1].Delivery.ID, tasks[2].Delivery.ID})
	assert.Equal(t, []int64{42, 7, 42}, []int64{tasks[0].Webhook.ID, tasks[1].Webhook.ID, tasks[2].Webhook.ID})
}

func TestUpdateTaskStatus_RecordsMetricsForSuccessRetryAndFailure(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name            string
		attempts        int32
		result          DeliveryResult
		wantAttempts    []string
		wantTerminal    []string
		expectRetryCall bool
	}{
		{
			name:         "success",
			attempts:     1,
			result:       DeliveryResult{StatusCode: 202, ResponseBody: "ok"},
			wantAttempts: []string{DeliveryOutcomeSuccess},
			wantTerminal: []string{DeliveryOutcomeSuccess},
		},
		{
			name:            "retry",
			attempts:        1,
			result:          DeliveryResult{StatusCode: 500, ResponseBody: "retry me", Err: assert.AnError},
			wantAttempts:    []string{DeliveryOutcomeRetry},
			wantTerminal:    nil,
			expectRetryCall: true,
		},
		{
			name:         "final failure",
			attempts:     4,
			result:       DeliveryResult{StatusCode: 500, ResponseBody: "boom", Err: assert.AnError},
			wantAttempts: []string{DeliveryOutcomeFailed},
			wantTerminal: []string{DeliveryOutcomeFailed},
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			resultCalls := 0
			retryCalls := 0
			store := &mockQueueStore{
				updateResultFn: func(_ context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
					resultCalls++
					if tc.expectRetryCall {
						t.Fatalf("unexpected result update: %+v", arg)
					}
					return nil
				},
				updateRetryFn: func(_ context.Context, arg db.UpdateWebhookDeliveryRetryParams) error {
					retryCalls++
					if !tc.expectRetryCall {
						t.Fatalf("unexpected retry update: %+v", arg)
					}
					return nil
				},
				listStatusFn: func(_ context.Context, webhookID int64) ([]string, error) {
					return []string{"failed"}, nil
				},
			}
			observer := &fakeWebhookMetricsObserver{}

			err := UpdateTaskStatus(context.Background(), store, Task{
				Delivery: db.WebhookDelivery{
					ID:        101,
					WebhookID: 42,
					Attempts:  tc.attempts,
				},
				Webhook: db.Webhook{ID: 42},
			}, tc.result, time.Date(2026, time.March, 12, 12, 0, 0, 0, time.UTC), observer)
			require.NoError(t, err)
			assert.Equal(t, tc.wantAttempts, observer.attempts)
			assert.Equal(t, tc.wantTerminal, observer.terminal)

			if tc.expectRetryCall {
				assert.Equal(t, 1, retryCalls)
				assert.Equal(t, 0, resultCalls)
			} else {
				assert.Equal(t, 0, retryCalls)
				assert.Equal(t, 1, resultCalls)
			}
		})
	}
}

func TestUpdateTaskStatus_DisabledWebhookSkipsRetryAndRecordsDisabledMetrics(t *testing.T) {
	t.Parallel()

	resultCalls := 0
	retryCalls := 0
	store := &mockQueueStore{
		updateResultFn: func(_ context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
			resultCalls++
			assert.Equal(t, "failed", arg.Status)
			assert.Equal(t, "webhook disabled", arg.ResponseBody)
			return nil
		},
		updateRetryFn: func(_ context.Context, arg db.UpdateWebhookDeliveryRetryParams) error {
			retryCalls++
			return nil
		},
	}
	observer := &fakeWebhookMetricsObserver{}

	err := UpdateTaskStatus(context.Background(), store, Task{
		Delivery: db.WebhookDelivery{
			ID:        301,
			WebhookID: 42,
			Attempts:  1,
		},
		Webhook: db.Webhook{ID: 42, IsActive: false},
	}, DeliveryResult{
		ResponseBody: "webhook disabled",
		Err:          assert.AnError,
		SkipRetry:    true,
		Disabled:     true,
	}, time.Date(2026, time.March, 12, 12, 0, 0, 0, time.UTC), observer)
	require.NoError(t, err)
	assert.Equal(t, 1, resultCalls)
	assert.Equal(t, 0, retryCalls)
	assert.Equal(t, []string{DeliveryOutcomeDisabled}, observer.attempts)
	assert.Equal(t, []string{DeliveryOutcomeDisabled}, observer.terminal)
}
