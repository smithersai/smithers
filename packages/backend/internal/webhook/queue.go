package webhook

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// QueueStore is the database API needed by webhook queue operations.
type QueueStore interface {
	ClaimDueWebhookDeliveries(ctx context.Context, claimLimit int32) ([]db.WebhookDelivery, error)
	ListWebhooksByIDs(ctx context.Context, ids []int64) ([]db.Webhook, error)
	UpdateWebhookDeliveryResult(ctx context.Context, arg db.UpdateWebhookDeliveryResultParams) error
	UpdateWebhookDeliveryRetry(ctx context.Context, arg db.UpdateWebhookDeliveryRetryParams) error
	ListRecentWebhookDeliveryStatuses(ctx context.Context, webhookID int64) ([]string, error)
	SetWebhookActive(ctx context.Context, arg db.SetWebhookActiveParams) error
}

// Task joins a claimed delivery row with its webhook definition.
type Task struct {
	Delivery db.WebhookDelivery
	Webhook  db.Webhook
}

// PollQueue claims due webhook deliveries and resolves webhook records.
func PollQueue(ctx context.Context, store QueueStore, limit int32) ([]Task, error) {
	deliveries, err := store.ClaimDueWebhookDeliveries(ctx, limit)
	if err != nil {
		return nil, err
	}
	if len(deliveries) == 0 {
		return nil, nil
	}

	webhookIDs := make([]int64, 0, len(deliveries))
	seenWebhookIDs := make(map[int64]struct{}, len(deliveries))
	for _, delivery := range deliveries {
		if _, seen := seenWebhookIDs[delivery.WebhookID]; seen {
			continue
		}
		seenWebhookIDs[delivery.WebhookID] = struct{}{}
		webhookIDs = append(webhookIDs, delivery.WebhookID)
	}

	webhooks, err := store.ListWebhooksByIDs(ctx, webhookIDs)
	if err != nil {
		return nil, err
	}

	webhooksByID := make(map[int64]db.Webhook, len(webhooks))
	for _, webhook := range webhooks {
		webhooksByID[webhook.ID] = webhook
	}

	tasks := make([]Task, 0, len(deliveries))
	for _, delivery := range deliveries {
		webhook, ok := webhooksByID[delivery.WebhookID]
		if !ok {
			return nil, fmt.Errorf("resolve webhook %d for delivery %d: not found", delivery.WebhookID, delivery.ID)
		}
		tasks = append(tasks, Task{Delivery: delivery, Webhook: webhook})
	}

	return tasks, nil
}

// UpdateTaskStatus persists a webhook attempt result and applies retry/disable policy.
func UpdateTaskStatus(ctx context.Context, store QueueStore, task Task, result DeliveryResult, now time.Time, observer MetricsObserver) error {
	result.ResponseBody = storableResponseBody(result.ResponseBody)
	responseStatus := toResponseStatus(result.StatusCode)
	if result.Err == nil && result.StatusCode >= 200 && result.StatusCode < 300 {
		if err := store.UpdateWebhookDeliveryResult(ctx, db.UpdateWebhookDeliveryResultParams{
			ID:             task.Delivery.ID,
			Status:         "success",
			ResponseStatus: responseStatus,
			ResponseBody:   result.ResponseBody,
		}); err != nil {
			return err
		}
		observeWebhookDeliveryAttempt(observer, DeliveryOutcomeSuccess)
		observeWebhookDeliveryTerminal(observer, DeliveryOutcomeSuccess)
		return nil
	}

	if !result.SkipRetry {
		if nextRetryAt, ok := CalculateNextRetry(task.Delivery.Attempts, now); ok {
			if err := store.UpdateWebhookDeliveryRetry(ctx, db.UpdateWebhookDeliveryRetryParams{
				ID:             task.Delivery.ID,
				Status:         "pending",
				ResponseStatus: responseStatus,
				ResponseBody:   result.ResponseBody,
				NextRetryAt:    pgtype.Timestamptz{Time: nextRetryAt, Valid: true},
			}); err != nil {
				return err
			}
			observeWebhookDeliveryAttempt(observer, DeliveryOutcomeRetry)
			return nil
		}
	}

	if err := store.UpdateWebhookDeliveryResult(ctx, db.UpdateWebhookDeliveryResultParams{
		ID:             task.Delivery.ID,
		Status:         "failed",
		ResponseStatus: responseStatus,
		ResponseBody:   result.ResponseBody,
	}); err != nil {
		return err
	}

	terminalOutcome := DeliveryOutcomeFailed
	if result.Disabled {
		terminalOutcome = DeliveryOutcomeDisabled
	}
	observeWebhookDeliveryAttempt(observer, terminalOutcome)
	observeWebhookDeliveryTerminal(observer, terminalOutcome)

	if result.Disabled {
		return nil
	}

	webhookID := task.Webhook.ID
	if webhookID == 0 {
		webhookID = task.Delivery.WebhookID
	}

	recentStatuses, err := store.ListRecentWebhookDeliveryStatuses(ctx, webhookID)
	if err != nil {
		return err
	}
	if shouldDisableWebhook(recentStatuses) {
		if err := store.SetWebhookActive(ctx, db.SetWebhookActiveParams{
			ID:       webhookID,
			IsActive: false,
		}); err != nil {
			return err
		}
	}

	return nil
}

// maxStoredResponseBodyBytes caps the receiver response kept for display.
const maxStoredResponseBodyBytes = 64 << 10

// storableResponseBody makes a receiver response safe for a Postgres text
// column. Postgres rejects NUL bytes and invalid UTF-8, and a rejected write
// leaves the delivery claimed, so it would be redelivered forever.
func storableResponseBody(body string) string {
	body = strings.ToValidUTF8(strings.ReplaceAll(body, "\x00", ""), "\uFFFD")
	if len(body) <= maxStoredResponseBodyBytes {
		return body
	}
	cut := maxStoredResponseBodyBytes
	for cut > 0 && !utf8.RuneStart(body[cut]) {
		cut--
	}
	return body[:cut]
}

func toResponseStatus(statusCode int) pgtype.Int4 {
	if statusCode <= 0 {
		return pgtype.Int4{}
	}
	return pgtype.Int4{Int32: int32(statusCode), Valid: true}
}
