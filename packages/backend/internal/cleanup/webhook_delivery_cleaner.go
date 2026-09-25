package cleanup

import (
	"context"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// WebhookDeliveryCleanupStore deletes settled deliveries past retention.
type WebhookDeliveryCleanupStore interface {
	DeleteTerminalWebhookDeliveriesOlderThan(context.Context, db.DeleteTerminalWebhookDeliveriesOlderThanParams) (int64, error)
}

// WebhookDeliveryCleaner keeps delivery history bounded without deleting
// pending work. One sweep drains the backlog in small database batches.
type WebhookDeliveryCleaner struct {
	periodicRunner
	store         WebhookDeliveryCleanupStore
	retentionDays int64
	batchSize     int32
}

func NewWebhookDeliveryCleaner(store WebhookDeliveryCleanupStore, interval time.Duration, retentionDays int64, batchSize int32) *WebhookDeliveryCleaner {
	if retentionDays <= 0 {
		retentionDays = 30
	}
	if batchSize <= 0 {
		batchSize = 1000
	}
	c := &WebhookDeliveryCleaner{store: store, retentionDays: retentionDays, batchSize: batchSize}
	c.init("webhook_delivery", interval, time.Hour)
	c.initialSweep = true
	return c
}

func (c *WebhookDeliveryCleaner) Start(ctx context.Context) { c.start(ctx, c.sweep) }

func (c *WebhookDeliveryCleaner) sweep(ctx context.Context) error {
	if c.store == nil {
		return nil
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		deleted, err := c.store.DeleteTerminalWebhookDeliveriesOlderThan(ctx, db.DeleteTerminalWebhookDeliveriesOlderThanParams{
			RetentionDays: c.retentionDays,
			BatchLimit:    c.batchSize,
		})
		if err != nil {
			return err
		}
		if deleted < int64(c.batchSize) {
			return nil
		}
	}
}
