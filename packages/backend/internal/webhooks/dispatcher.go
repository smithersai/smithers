package webhooks

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Store is the DB API required to enqueue webhook deliveries from domain events.
type Store interface {
	ListActiveWebhooksByRepo(ctx context.Context, repositoryID int64) ([]db.Webhook, error)
	ListActiveWebhooksByOrg(ctx context.Context, orgID int64) ([]db.Webhook, error)
	CreateWebhookDelivery(ctx context.Context, arg db.CreateWebhookDeliveryParams) (db.WebhookDelivery, error)
}

// Dispatcher enqueues matching webhooks for a domain event.
type Dispatcher interface {
	DispatchEvent(ctx context.Context, repoID int64, eventType EventType, payload any) error
	// DispatchOrgEvent enqueues deliveries for webhooks belonging to all repos
	// under the given organization. Used for organization- and team-level events
	// that are not tied to a single repository.
	DispatchOrgEvent(ctx context.Context, orgID int64, eventType EventType, payload any) error
}

type dispatcher struct {
	store Store
}

func NewDispatcher(store Store) Dispatcher {
	return &dispatcher{store: store}
}

func (d *dispatcher) DispatchEvent(ctx context.Context, repoID int64, eventType EventType, payload any) error {
	if repoID <= 0 {
		return fmt.Errorf("invalid repository id: %d", repoID)
	}

	webhooks, err := d.store.ListActiveWebhooksByRepo(ctx, repoID)
	if err != nil {
		return err
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	event := string(eventType)
	for _, hook := range webhooks {
		if !hook.IsActive || !isSubscribedToEvent(hook.Events, event) {
			continue
		}

		if _, err := d.store.CreateWebhookDelivery(ctx, db.CreateWebhookDeliveryParams{
			WebhookID: hook.ID,
			EventType: event,
			Payload:   body,
			Status:    "pending",
		}); err != nil {
			return err
		}
	}

	return nil
}

func (d *dispatcher) DispatchOrgEvent(ctx context.Context, orgID int64, eventType EventType, payload any) error {
	if orgID <= 0 {
		return fmt.Errorf("invalid organization id: %d", orgID)
	}

	hooks, err := d.store.ListActiveWebhooksByOrg(ctx, orgID)
	if err != nil {
		return err
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	event := string(eventType)
	for _, hook := range hooks {
		if !hook.IsActive || !isSubscribedToEvent(hook.Events, event) {
			continue
		}

		if _, err := d.store.CreateWebhookDelivery(ctx, db.CreateWebhookDeliveryParams{
			WebhookID: hook.ID,
			EventType: event,
			Payload:   body,
			Status:    "pending",
		}); err != nil {
			return err
		}
	}

	return nil
}

func isSubscribedToEvent(events []string, event string) bool {
	needle := strings.ToLower(strings.TrimSpace(event))
	if needle == "" {
		return false
	}

	for _, candidate := range events {
		normalized := strings.ToLower(strings.TrimSpace(candidate))
		if normalized == needle || normalized == "all" || normalized == "*" {
			return true
		}
	}

	return false
}
