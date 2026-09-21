package webhook

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func queueCovTask(attempts int32) Task {
	return Task{
		Delivery: db.WebhookDelivery{
			ID:        701,
			WebhookID: 901,
			Attempts:  attempts,
		},
		Webhook: db.Webhook{ID: 901},
	}
}

func TestQueue_Cov_PollQueuePropagatesListError(t *testing.T) {
	t.Parallel()

	expectedErr := errors.New("list webhooks failed")
	store := &mockQueueStore{
		claimFn: func(_ context.Context, limit int32) ([]db.WebhookDelivery, error) {
			assert.Equal(t, int32(5), limit)
			return []db.WebhookDelivery{{ID: 11, WebhookID: 22}}, nil
		},
		listWebhooksFn: func(_ context.Context, ids []int64) ([]db.Webhook, error) {
			assert.Equal(t, []int64{22}, ids)
			return nil, expectedErr
		},
	}

	tasks, err := PollQueue(context.Background(), store, 5)

	require.ErrorIs(t, err, expectedErr)
	assert.Nil(t, tasks)
}

func TestQueue_Cov_PollQueueErrorsWhenWebhookMissing(t *testing.T) {
	t.Parallel()

	store := &mockQueueStore{
		claimFn: func(_ context.Context, _ int32) ([]db.WebhookDelivery, error) {
			return []db.WebhookDelivery{{ID: 12, WebhookID: 34}}, nil
		},
		listWebhooksFn: func(_ context.Context, ids []int64) ([]db.Webhook, error) {
			assert.Equal(t, []int64{34}, ids)
			return []db.Webhook{{ID: 99}}, nil
		},
	}

	tasks, err := PollQueue(context.Background(), store, 1)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "resolve webhook 34 for delivery 12: not found")
	assert.Nil(t, tasks)
}

func TestQueue_Cov_UpdateTaskStatusPropagatesSuccessUpdateError(t *testing.T) {
	t.Parallel()

	expectedErr := errors.New("success update failed")
	observer := &fakeWebhookMetricsObserver{}
	store := &mockQueueStore{
		updateResultFn: func(_ context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
			assert.Equal(t, "success", arg.Status)
			assert.True(t, arg.ResponseStatus.Valid)
			assert.Equal(t, int32(204), arg.ResponseStatus.Int32)
			return expectedErr
		},
	}

	err := UpdateTaskStatus(context.Background(), store, queueCovTask(1), DeliveryResult{
		StatusCode:   204,
		ResponseBody: "accepted",
	}, time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC), observer)

	require.ErrorIs(t, err, expectedErr)
	assert.Empty(t, observer.attempts)
	assert.Empty(t, observer.terminal)
}

func TestQueue_Cov_UpdateTaskStatusPropagatesRetryUpdateError(t *testing.T) {
	t.Parallel()

	expectedErr := errors.New("retry update failed")
	store := &mockQueueStore{
		updateRetryFn: func(_ context.Context, arg db.UpdateWebhookDeliveryRetryParams) error {
			assert.Equal(t, "pending", arg.Status)
			assert.True(t, arg.NextRetryAt.Valid)
			return expectedErr
		},
	}

	err := UpdateTaskStatus(context.Background(), store, queueCovTask(1), DeliveryResult{
		StatusCode:   503,
		ResponseBody: "try later",
		Err:          errors.New("remote failed"),
	}, time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC), nil)

	require.ErrorIs(t, err, expectedErr)
}

func TestQueue_Cov_UpdateTaskStatusPropagatesFinalUpdateError(t *testing.T) {
	t.Parallel()

	expectedErr := errors.New("final update failed")
	store := &mockQueueStore{
		updateResultFn: func(_ context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
			assert.Equal(t, "failed", arg.Status)
			assert.Equal(t, "terminal", arg.ResponseBody)
			return expectedErr
		},
	}

	err := UpdateTaskStatus(context.Background(), store, queueCovTask(4), DeliveryResult{
		StatusCode:   500,
		ResponseBody: "terminal",
		Err:          errors.New("remote failed"),
	}, time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC), nil)

	require.ErrorIs(t, err, expectedErr)
}

func TestQueue_Cov_UpdateTaskStatusPropagatesRecentStatusError(t *testing.T) {
	t.Parallel()

	expectedErr := errors.New("recent status lookup failed")
	store := &mockQueueStore{
		updateResultFn: func(_ context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
			assert.Equal(t, "failed", arg.Status)
			return nil
		},
		listStatusFn: func(_ context.Context, webhookID int64) ([]string, error) {
			assert.Equal(t, int64(901), webhookID)
			return nil, expectedErr
		},
		setActiveFn: func(_ context.Context, arg db.SetWebhookActiveParams) error {
			t.Fatalf("unexpected deactivate call: %+v", arg)
			return nil
		},
	}

	err := UpdateTaskStatus(context.Background(), store, queueCovTask(4), DeliveryResult{
		StatusCode:   500,
		ResponseBody: "terminal",
		Err:          errors.New("remote failed"),
	}, time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC), nil)

	require.ErrorIs(t, err, expectedErr)
}

func TestQueue_Cov_UpdateTaskStatusPropagatesDeactivateError(t *testing.T) {
	t.Parallel()

	expectedErr := errors.New("deactivate failed")
	store := &mockQueueStore{
		updateResultFn: func(_ context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
			assert.Equal(t, "failed", arg.Status)
			return nil
		},
		listStatusFn: func(_ context.Context, webhookID int64) ([]string, error) {
			assert.Equal(t, int64(901), webhookID)
			return []string{
				"failed", "failed", "failed", "failed", "failed",
				"failed", "failed", "failed", "failed", "failed",
			}, nil
		},
		setActiveFn: func(_ context.Context, arg db.SetWebhookActiveParams) error {
			assert.Equal(t, int64(901), arg.ID)
			assert.False(t, arg.IsActive)
			return expectedErr
		},
	}

	err := UpdateTaskStatus(context.Background(), store, queueCovTask(4), DeliveryResult{
		StatusCode:   500,
		ResponseBody: "terminal",
		Err:          errors.New("remote failed"),
	}, time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC), nil)

	require.ErrorIs(t, err, expectedErr)
}
