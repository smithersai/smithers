package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/stripe/stripe-go/v86"
)

var billingStripeCovMu sync.Mutex

func billingStripeCovClient(t *testing.T, handler http.HandlerFunc) *stripeBillingClient {
	t.Helper()
	billingStripeCovMu.Lock()
	t.Cleanup(billingStripeCovMu.Unlock)

	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	oldBackend := stripe.GetBackend(stripe.APIBackend)
	oldKey := stripe.Key
	backend := stripe.GetBackendWithConfig(stripe.APIBackend, &stripe.BackendConfig{
		URL:             stripe.String(server.URL),
		HTTPClient:      server.Client(),
		EnableTelemetry: stripe.Bool(false),
	})
	stripe.SetBackend(stripe.APIBackend, backend)
	stripe.Key = ""
	t.Cleanup(func() {
		stripe.SetBackend(stripe.APIBackend, oldBackend)
		stripe.Key = oldKey
	})

	client := NewStripeBillingClient(" sk_test_cov ").(*stripeBillingClient)
	require.Equal(t, "sk_test_cov", client.secretKey)
	return client
}

func billingStripeCovWriteJSON(t *testing.T, w http.ResponseWriter, payload map[string]any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	require.NoError(t, json.NewEncoder(w).Encode(payload))
}

func TestBillingStripe_Cov_ConstructorAndCustomerCheckoutPortal(t *testing.T) {
	assert.Nil(t, NewStripeBillingClient("   "))
	var seen []string
	client := billingStripeCovClient(t, func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, r.ParseForm())
		seen = append(seen, r.Method+" "+r.URL.Path)
		assert.Equal(t, "Bearer sk_test_cov", r.Header.Get("Authorization"))
		switch r.URL.Path {
		case "/v1/customers":
			assert.Equal(t, "Ada", r.Form.Get("name"))
			assert.Equal(t, "ada@example.com", r.Form.Get("email"))
			assert.Equal(t, "user", r.Form.Get("metadata[owner_type]"))
			billingStripeCovWriteJSON(t, w, map[string]any{"id": "cus_cov", "object": "customer"})
		case "/v1/checkout/sessions":
			assert.Equal(t, "cus_cov", r.Form.Get("customer"))
			assert.Equal(t, "user:42", r.Form.Get("client_reference_id"))
			assert.Equal(t, stripeCheckoutIdempotencyKey(StripeCreateCheckoutSessionInput{
				CustomerID: "cus_cov",
				Metadata: map[string]string{
					"owner_type": "user",
					"owner_id":   "42",
					"plan_key":   "pro",
					"interval":   "monthly",
				},
			}), r.Header.Get("Idempotency-Key"))
			assert.Equal(t, "https://ok", r.Form.Get("success_url"))
			assert.Equal(t, "price_cov", r.Form.Get("line_items[0][price]"))
			assert.Equal(t, "2", r.Form.Get("line_items[0][quantity]"))
			assert.Equal(t, "true", r.Form.Get("allow_promotion_codes"))
			billingStripeCovWriteJSON(t, w, map[string]any{"id": "cs_cov", "object": "checkout.session", "url": "https://checkout.example"})
		case "/v1/billing_portal/sessions":
			assert.Equal(t, "cus_cov", r.Form.Get("customer"))
			assert.Equal(t, "https://return", r.Form.Get("return_url"))
			billingStripeCovWriteJSON(t, w, map[string]any{"id": "bps_cov", "object": "billing_portal.session", "url": "https://portal.example"})
		default:
			t.Fatalf("unexpected stripe path %s", r.URL.Path)
		}
	})

	customerID, err := client.CreateCustomer(context.Background(), StripeCreateCustomerInput{Name: " Ada ", Email: " ada@example.com ", Metadata: map[string]string{"owner_type": "user"}})
	require.NoError(t, err)
	assert.Equal(t, "cus_cov", customerID)

	checkout, err := client.CreateCheckoutSession(context.Background(), StripeCreateCheckoutSessionInput{
		CustomerID: " cus_cov ",
		SuccessURL: " https://ok ",
		CancelURL:  " https://cancel ",
		PriceID:    " price_cov ",
		Quantity:   2,
		Metadata: map[string]string{
			"owner_type": "user",
			"owner_id":   "42",
			"plan_key":   "pro",
			"interval":   "monthly",
		},
	})
	require.NoError(t, err)
	assert.Equal(t, StripeCheckoutSessionResult{ID: "cs_cov", URL: "https://checkout.example"}, checkout)

	portal, err := client.CreatePortalSession(context.Background(), StripeCreatePortalSessionInput{CustomerID: " cus_cov ", ReturnURL: " https://return "})
	require.NoError(t, err)
	assert.Equal(t, "https://portal.example", portal)
	assert.Equal(t, []string{"POST /v1/customers", "POST /v1/checkout/sessions", "POST /v1/billing_portal/sessions"}, seen)
}

func TestBillingStripe_Cov_SubscriptionChargeSessionsAndEntitlements(t *testing.T) {
	client := billingStripeCovClient(t, func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, r.ParseForm())
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/checkout/sessions":
			assert.Equal(t, "cus_cov", r.Form.Get("customer"))
			assert.Equal(t, "1", r.Form.Get("limit"))
			billingStripeCovWriteJSON(t, w, map[string]any{
				"object":   "list",
				"has_more": false,
				"data": []map[string]any{{
					"id":           "cs_latest",
					"object":       "checkout.session",
					"url":          "https://checkout.example/latest",
					"status":       "open",
					"subscription": "sub_latest",
					"metadata":     map[string]string{"plan_key": "pro"},
				}},
			})
		case "POST /v1/checkout/sessions/cs_1/expire":
			billingStripeCovWriteJSON(t, w, map[string]any{"id": "cs_1", "object": "checkout.session", "status": "expired"})
		case "DELETE /v1/subscriptions/sub_cov":
			billingStripeCovWriteJSON(t, w, map[string]any{"id": "sub_cov", "object": "subscription", "status": "canceled"})
		case "GET /v1/subscriptions/sub_cov":
			billingStripeCovWriteJSON(t, w, map[string]any{
				"id":                   "sub_cov",
				"object":               "subscription",
				"customer":             "cus_cov",
				"status":               "active",
				"cancel_at_period_end": true,
				"canceled_at":          int64(100),
				"trial_end":            int64(200),
				"metadata":             map[string]string{"plan_key": "pro"},
				"items": map[string]any{
					"object": "list",
					"data": []map[string]any{{
						"id":                   "si_cov",
						"object":               "subscription_item",
						"quantity":             3,
						"current_period_start": int64(300),
						"current_period_end":   int64(400),
						"price": map[string]any{
							"id":        "price_cov",
							"object":    "price",
							"recurring": map[string]any{"interval": "month"},
						},
					}},
				},
			})
		case "POST /v1/subscriptions/sub_cov":
			assert.Equal(t, "si_cov", r.Form.Get("items[0][id]"))
			assert.Equal(t, "5", r.Form.Get("items[0][quantity]"))
			assert.Equal(t, "create_prorations", r.Form.Get("proration_behavior"))
			billingStripeCovWriteJSON(t, w, map[string]any{
				"id":     "sub_cov",
				"object": "subscription",
				"status": "active",
			})
		case "GET /v1/charges/ch_cov":
			billingStripeCovWriteJSON(t, w, map[string]any{
				"id":              "ch_cov",
				"object":          "charge",
				"customer":        "cus_cov",
				"payment_intent":  "pi_cov",
				"amount_refunded": 1250,
				"currency":        "usd",
			})
		case "GET /v1/entitlements/active_entitlements":
			assert.Equal(t, "cus_cov", r.Form.Get("customer"))
			billingStripeCovWriteJSON(t, w, map[string]any{
				"object":   "list",
				"has_more": false,
				"data": []map[string]any{
					{"id": "ent_1", "object": "entitlements.active_entitlement", "lookup_key": "priority"},
					{"id": "ent_2", "object": "entitlements.active_entitlement", "feature": map[string]any{"lookup_key": "priority"}},
					{"id": "ent_3", "object": "entitlements.active_entitlement", "feature": map[string]any{"lookup_key": "storage"}},
					{"id": "ent_4", "object": "entitlements.active_entitlement"},
				},
			})
		default:
			t.Fatalf("unexpected stripe request %s %s", r.Method, r.URL.Path)
		}
	})

	latest, found, err := client.GetLatestCheckoutSession(context.Background(), " cus_cov ")
	require.NoError(t, err)
	require.True(t, found)
	assert.Equal(t, StripeCheckoutSessionSnapshot{
		ID:             "cs_latest",
		URL:            "https://checkout.example/latest",
		Status:         "open",
		SubscriptionID: "sub_latest",
		Metadata:       map[string]string{"plan_key": "pro"},
	}, latest)

	require.NoError(t, client.ExpireCheckoutSession(context.Background(), " cs_1 "))
	require.NoError(t, client.CancelSubscription(context.Background(), " sub_cov "))
	require.NoError(t, client.UpdateSubscriptionQuantity(context.Background(), " sub_cov ", 5))

	sub, err := client.GetSubscription(context.Background(), " sub_cov ")
	require.NoError(t, err)
	assert.Equal(t, "sub_cov", sub.ID)
	assert.Equal(t, "cus_cov", sub.CustomerID)
	assert.Equal(t, "price_cov", sub.PriceID)
	assert.Equal(t, "monthly", sub.Interval)
	assert.Equal(t, int64(3), sub.Quantity)
	assert.Equal(t, time.Unix(200, 0).UTC(), sub.TrialEnd)
	assert.NotEmpty(t, sub.RawPayload)

	charge, err := client.GetCharge(context.Background(), " ch_cov ")
	require.NoError(t, err)
	assert.Equal(t, "cus_cov", charge.CustomerID)
	assert.Equal(t, "pi_cov", charge.PaymentIntent)
	assert.Equal(t, int64(1250), charge.AmountRefunded)

	entitlements, err := client.ListActiveEntitlements(context.Background(), " cus_cov ")
	require.NoError(t, err)
	assert.Equal(t, []string{"priority", "storage"}, entitlements)
}

func TestBillingStripe_CheckoutIdempotencyIsGenerationScoped(t *testing.T) {
	base := StripeCreateCheckoutSessionInput{
		CustomerID:         "cus_123",
		Quantity:           1,
		CheckoutGeneration: "cs_previous",
		Metadata: map[string]string{
			"owner_type": "org",
			"owner_id":   "7",
			"plan_key":   "team",
			"interval":   "monthly",
		},
	}

	mismatchedConcurrent := base
	mismatchedConcurrent.Quantity = 5
	mismatchedConcurrent.Metadata = map[string]string{
		"owner_type": "org",
		"owner_id":   "7",
		"plan_key":   "enterprise",
		"interval":   "annual",
	}
	assert.Equal(t, stripeCheckoutIdempotencyKey(base), stripeCheckoutIdempotencyKey(mismatchedConcurrent),
		"concurrent requests in one generation must collide at Stripe rather than create two subscriptions")

	nextGeneration := base
	nextGeneration.CheckoutGeneration = "cs_newer"
	assert.NotEqual(t, stripeCheckoutIdempotencyKey(base), stripeCheckoutIdempotencyKey(nextGeneration))
	assert.Equal(t, "org:7", stripeCheckoutClientReference(base))
}
