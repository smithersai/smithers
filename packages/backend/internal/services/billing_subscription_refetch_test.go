package services

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Stripe subscription webhooks arrive without ordering guarantees. A stale
// customer.subscription.updated carrying status "active" must NOT overwrite a
// newer canceled state — handleSubscriptionEvent re-fetches the authoritative
// snapshot from Stripe and persists that instead of the (possibly stale) payload.
func TestBillingService_HandleStripeWebhook_RefetchOverridesStaleSubscriptionStatus(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	queries.upsertBillingAccountFn = func(_ context.Context, arg db.UpsertBillingAccountParams) (db.BillingAccount, error) {
		return db.BillingAccount{ID: 7, OwnerType: arg.OwnerType, OwnerID: arg.OwnerID, StripeCustomerID: arg.StripeCustomerID}, nil
	}
	var got db.UpsertBillingSubscriptionParams
	queries.upsertBillingSubscriptionFn = func(_ context.Context, arg db.UpsertBillingSubscriptionParams) (db.BillingSubscription, error) {
		got = arg
		return db.BillingSubscription{}, nil
	}

	var refetched string
	client := &stripeBillingClientMock{
		getSubscriptionFn: func(_ context.Context, id string) (StripeSubscriptionSnapshot, error) {
			refetched = id
			// Authoritative current state: the subscription is actually canceled.
			return StripeSubscriptionSnapshot{
				ID:     id,
				Status: "canceled",
				Metadata: map[string]string{
					"owner_type": "org", "owner_id": "77", "plan_key": "team", "interval": "monthly",
				},
			}, nil
		},
	}
	svc := NewBillingService(queries, client, BillingServiceConfig{
		StripeWebhookSecret: "whsec_test_secret",
		TeamMonthlyPriceID:  "price_team_monthly",
	})

	// Stale webhook payload still says the subscription is active.
	payload, signature := signedStripeEvent(t, "evt_stale_1", "customer.subscription.updated", map[string]any{
		"id":                   "sub_test_123",
		"customer":             "cus_test_123",
		"status":               "active",
		"cancel_at_period_end": false,
		"current_period_start": time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC).Unix(),
		"current_period_end":   time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC).Unix(),
		"metadata":             map[string]any{"owner_type": "org", "owner_id": "77"},
		"items": map[string]any{"data": []map[string]any{{
			"quantity": 12,
			"price":    map[string]any{"id": "price_team_monthly", "recurring": map[string]any{"interval": "month"}},
		}}},
	})

	require.NoError(t, svc.HandleStripeWebhook(context.Background(), payload, signature))
	assert.Equal(t, "sub_test_123", refetched, "handler must re-fetch the subscription from Stripe")
	assert.Equal(t, "canceled", got.Status, "authoritative Stripe status must override the stale webhook payload")
}
