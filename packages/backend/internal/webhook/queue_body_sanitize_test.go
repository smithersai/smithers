package webhook

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// postgresTextGuard rejects values Postgres text columns reject: NUL bytes and
// invalid UTF-8.
func postgresTextGuard(body string) error {
	if strings.ContainsRune(body, 0) || !utf8.ValidString(body) {
		return errors.New("invalid byte sequence for encoding \"UTF8\"")
	}
	return nil
}

func TestUpdateTaskStatus_StoresBinaryResponseBodyAsValidText(t *testing.T) {
	t.Parallel()

	binary := "ok\x00\x1f\x8b\xff\xfe tail"
	var stored []string
	store := &mockQueueStore{
		updateResultFn: func(_ context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
			if err := postgresTextGuard(arg.ResponseBody); err != nil {
				return err
			}
			stored = append(stored, arg.ResponseBody)
			return nil
		},
		updateRetryFn: func(_ context.Context, arg db.UpdateWebhookDeliveryRetryParams) error {
			if err := postgresTextGuard(arg.ResponseBody); err != nil {
				return err
			}
			stored = append(stored, arg.ResponseBody)
			return nil
		},
	}

	task := Task{Delivery: db.WebhookDelivery{ID: 1, WebhookID: 2, Attempts: 1}, Webhook: db.Webhook{ID: 2}}
	require.NoError(t, UpdateTaskStatus(context.Background(), store, task, DeliveryResult{StatusCode: 200, ResponseBody: binary}, time.Now(), nil))
	require.NoError(t, UpdateTaskStatus(context.Background(), store, task, DeliveryResult{StatusCode: 500, ResponseBody: binary}, time.Now(), nil))
	task.Delivery.Attempts = 99
	require.NoError(t, UpdateTaskStatus(context.Background(), store, task, DeliveryResult{StatusCode: 500, ResponseBody: binary}, time.Now(), nil))

	require.Len(t, stored, 3)
	for _, body := range stored {
		require.True(t, strings.HasPrefix(body, "ok"))
		require.True(t, strings.HasSuffix(body, " tail"))
	}
}

func TestUpdateTaskStatus_CapsStoredResponseBody(t *testing.T) {
	t.Parallel()

	var stored string
	store := &mockQueueStore{
		updateResultFn: func(_ context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
			stored = arg.ResponseBody
			return nil
		},
	}
	task := Task{Delivery: db.WebhookDelivery{ID: 1, WebhookID: 2, Attempts: 1}, Webhook: db.Webhook{ID: 2}}
	// A multi-byte rune straddling the cap must not be split into invalid UTF-8.
	body := strings.Repeat("a", maxStoredResponseBodyBytes-1) + "é" + strings.Repeat("b", 10)
	require.NoError(t, UpdateTaskStatus(context.Background(), store, task, DeliveryResult{StatusCode: 200, ResponseBody: body}, time.Now(), nil))
	require.LessOrEqual(t, len(stored), maxStoredResponseBodyBytes)
	require.True(t, utf8.ValidString(stored))
}
