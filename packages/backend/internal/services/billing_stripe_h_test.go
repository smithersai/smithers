package services

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBillingStripe_H_ErrorBranches(t *testing.T) {
	for _, tc := range []struct {
		name string
		call func(*stripeBillingClient) error
	}{
		{name: "customer", call: func(c *stripeBillingClient) error {
			_, err := c.CreateCustomer(context.Background(), StripeCreateCustomerInput{Name: "Ada"})
			return err
		}},
		{name: "checkout", call: func(c *stripeBillingClient) error {
			_, err := c.CreateCheckoutSession(context.Background(), StripeCreateCheckoutSessionInput{CustomerID: "cus", PriceID: "price", Quantity: 1})
			return err
		}},
		{name: "portal", call: func(c *stripeBillingClient) error {
			_, err := c.CreatePortalSession(context.Background(), StripeCreatePortalSessionInput{CustomerID: "cus"})
			return err
		}},
		{name: "latest checkout", call: func(c *stripeBillingClient) error {
			_, _, err := c.GetLatestCheckoutSession(context.Background(), "cus")
			return err
		}},
		{name: "subscription", call: func(c *stripeBillingClient) error {
			_, err := c.GetSubscription(context.Background(), "sub")
			return err
		}},
		{name: "charge", call: func(c *stripeBillingClient) error {
			_, err := c.GetCharge(context.Background(), "ch")
			return err
		}},
		{name: "entitlements", call: func(c *stripeBillingClient) error {
			_, err := c.ListActiveEntitlements(context.Background(), "cus")
			return err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := billingStripeCovClient(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"error":{"message":"boom"}}`))
			})
			require.Error(t, tc.call(client))
		})
	}
}

func TestBillingStripe_H_OptionalSnapshotFieldsAndNilEntitlements(t *testing.T) {
	client := billingStripeCovClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/subscriptions/sub_min":
			billingStripeCovWriteJSON(t, w, map[string]any{
				"id":     "sub_min",
				"object": "subscription",
				"status": "trialing",
				"items":  map[string]any{"object": "list", "data": []any{}},
			})
		case "/v1/charges/ch_min":
			billingStripeCovWriteJSON(t, w, map[string]any{
				"id":              "ch_min",
				"object":          "charge",
				"amount_refunded": 0,
				"currency":        "usd",
			})
		case "/v1/entitlements/active_entitlements":
			billingStripeCovWriteJSON(t, w, map[string]any{
				"object":   "list",
				"has_more": false,
				"data": []any{
					nil,
					map[string]any{"id": "ent_blank", "object": "entitlements.active_entitlement", "lookup_key": " "},
					map[string]any{"id": "ent_feature", "object": "entitlements.active_entitlement", "feature": map[string]any{"lookup_key": "storage"}},
				},
			})
		default:
			t.Fatalf("unexpected stripe path %s", r.URL.Path)
		}
	})

	sub, err := client.GetSubscription(context.Background(), " sub_min ")
	require.NoError(t, err)
	assert.Equal(t, "sub_min", sub.ID)
	assert.Empty(t, sub.CustomerID)
	assert.Equal(t, int64(1), sub.Quantity)

	charge, err := client.GetCharge(context.Background(), " ch_min ")
	require.NoError(t, err)
	assert.Equal(t, "ch_min", charge.ID)
	assert.Empty(t, charge.CustomerID)
	assert.Empty(t, charge.PaymentIntent)

	entitlements, err := client.ListActiveEntitlements(context.Background(), " cus ")
	require.NoError(t, err)
	assert.Equal(t, []string{"storage"}, entitlements)
}
