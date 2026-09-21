package routes

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// WebhookResponse is the API response DTO for webhooks.
// It masks the secret field to prevent exposure in API responses,
// following GitHub/Gitea industry convention.
type WebhookResponse struct {
	ID             int64              `json:"id"`
	RepositoryID   int64              `json:"repository_id"`
	URL            string             `json:"url"`
	Secret         string             `json:"secret"` // always "********" or ""
	Events         []string           `json:"events"`
	IsActive       bool               `json:"is_active"`
	LastDeliveryAt pgtype.Timestamptz `json:"last_delivery_at"`
	CreatedAt      time.Time          `json:"created_at"`
	UpdatedAt      time.Time          `json:"updated_at"`
}

// maskWebhookSecret returns "********" if secret is non-empty, "" otherwise.
// This follows the GitHub/Gitea pattern: show a placeholder when a secret
// exists but never expose the actual value.
func maskWebhookSecret(secret string) string {
	if secret == "" {
		return ""
	}
	return "********"
}

// toWebhookResponse converts a db.Webhook to a WebhookResponse, masking the secret.
func toWebhookResponse(w db.Webhook) WebhookResponse {
	return WebhookResponse{
		ID:             w.ID,
		RepositoryID:   w.RepositoryID,
		URL:            w.Url,
		Secret:         maskWebhookSecret(w.Secret),
		Events:         w.Events,
		IsActive:       w.IsActive,
		LastDeliveryAt: w.LastDeliveryAt,
		CreatedAt:      w.CreatedAt,
		UpdatedAt:      w.UpdatedAt,
	}
}

// toWebhookResponseList converts a slice of db.Webhook to []WebhookResponse,
// masking all secrets. Returns an empty (non-nil) slice for nil or empty input.
func toWebhookResponseList(webhooks []db.Webhook) []WebhookResponse {
	result := make([]WebhookResponse, len(webhooks))
	for i, w := range webhooks {
		result[i] = toWebhookResponse(w)
	}
	return result
}
