package services

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"
	"time"

	"github.com/stripe/stripe-go/v86"
	billingportalsession "github.com/stripe/stripe-go/v86/billingportal/session"
	stripecharge "github.com/stripe/stripe-go/v86/charge"
	checkoutsession "github.com/stripe/stripe-go/v86/checkout/session"
	"github.com/stripe/stripe-go/v86/customer"
	"github.com/stripe/stripe-go/v86/entitlements/activeentitlement"
	"github.com/stripe/stripe-go/v86/subscription"
)

type StripeCreateCustomerInput struct {
	Name     string
	Email    string
	Metadata map[string]string
}

type StripeCreateCheckoutSessionInput struct {
	CustomerID         string
	SuccessURL         string
	CancelURL          string
	PriceID            string
	Quantity           int64
	CheckoutGeneration string
	Metadata           map[string]string
}

type StripeCreatePortalSessionInput struct {
	CustomerID string
	ReturnURL  string
}

type StripeCheckoutSessionResult struct {
	ID  string
	URL string
}

type StripeCheckoutSessionSnapshot struct {
	ID             string
	URL            string
	Status         string
	SubscriptionID string
	Metadata       map[string]string
}

type StripeSubscriptionSnapshot struct {
	ID                 string
	CustomerID         string
	PriceID            string
	PlanKey            string
	Interval           string
	Status             string
	Quantity           int64
	TrialEnd           time.Time
	CurrentPeriodStart time.Time
	CurrentPeriodEnd   time.Time
	CancelAtPeriodEnd  bool
	CanceledAt         time.Time
	Metadata           map[string]string
	RawPayload         []byte
}

type StripeChargeSnapshot struct {
	ID             string
	CustomerID     string
	PaymentIntent  string
	AmountRefunded int64
	Currency       string
}

type stripeBillingClient struct {
	secretKey string
}

func NewStripeBillingClient(secretKey string) StripeBillingClient {
	if strings.TrimSpace(secretKey) == "" {
		return nil
	}
	return &stripeBillingClient{secretKey: strings.TrimSpace(secretKey)}
}

func (c *stripeBillingClient) withKey() {
	stripe.Key = c.secretKey
}

func (c *stripeBillingClient) CreateCustomer(ctx context.Context, input StripeCreateCustomerInput) (string, error) {
	c.withKey()
	params := &stripe.CustomerParams{}
	params.Context = ctx
	if strings.TrimSpace(input.Name) != "" {
		params.Name = stripe.String(strings.TrimSpace(input.Name))
	}
	if strings.TrimSpace(input.Email) != "" {
		params.Email = stripe.String(strings.TrimSpace(input.Email))
	}
	params.Metadata = input.Metadata
	result, err := customer.New(params)
	if err != nil {
		return "", err
	}
	return result.ID, nil
}

func (c *stripeBillingClient) CreateCheckoutSession(ctx context.Context, input StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error) {
	c.withKey()
	params := &stripe.CheckoutSessionParams{
		Customer:          stripe.String(strings.TrimSpace(input.CustomerID)),
		SuccessURL:        stripe.String(strings.TrimSpace(input.SuccessURL)),
		CancelURL:         stripe.String(strings.TrimSpace(input.CancelURL)),
		Mode:              stripe.String(string(stripe.CheckoutSessionModeSubscription)),
		Metadata:          input.Metadata,
		ClientReferenceID: stripe.String(stripeCheckoutClientReference(input)),
		LineItems: []*stripe.CheckoutSessionLineItemParams{
			{
				Price:    stripe.String(strings.TrimSpace(input.PriceID)),
				Quantity: stripe.Int64(input.Quantity),
			},
		},
		AllowPromotionCodes: stripe.Bool(true),
		SubscriptionData: &stripe.CheckoutSessionSubscriptionDataParams{
			Metadata: input.Metadata,
		},
	}
	params.Context = ctx
	params.SetIdempotencyKey(stripeCheckoutIdempotencyKey(input))
	result, err := checkoutsession.New(params)
	if err != nil {
		return StripeCheckoutSessionResult{}, err
	}
	return StripeCheckoutSessionResult{
		ID:  result.ID,
		URL: result.URL,
	}, nil
}

// stripeCheckoutClientReference gives Stripe a stable, human-readable owner
// reference for reconciliation. Older/internal callers that omit owner
// metadata safely fall back to the already-account-scoped Stripe customer ID.
func stripeCheckoutClientReference(input StripeCreateCheckoutSessionInput) string {
	ownerType := strings.TrimSpace(input.Metadata["owner_type"])
	ownerID := strings.TrimSpace(input.Metadata["owner_id"])
	if ownerType != "" && ownerID != "" {
		return ownerType + ":" + ownerID
	}
	return strings.TrimSpace(input.CustomerID)
}

// stripeCheckoutIdempotencyKey collapses simultaneous checkout requests for
// the same billing account and checkout generation into one Stripe session.
// Plan, interval, and quantity are intentionally not part of the identity: if
// concurrent requests disagree, Stripe rejects the mismatched replay instead
// of creating a second subscription that could double-charge the account.
func stripeCheckoutIdempotencyKey(input StripeCreateCheckoutSessionInput) string {
	generation := strings.TrimSpace(input.CheckoutGeneration)
	if generation == "" {
		generation = "initial"
	}
	identity := strings.Join([]string{
		strings.TrimSpace(input.CustomerID),
		generation,
	}, "\x00")
	digest := sha256.Sum256([]byte(identity))
	return fmt.Sprintf("plue-checkout-%x", digest)
}

func (c *stripeBillingClient) CreatePortalSession(ctx context.Context, input StripeCreatePortalSessionInput) (string, error) {
	c.withKey()
	params := &stripe.BillingPortalSessionParams{
		Customer: stripe.String(strings.TrimSpace(input.CustomerID)),
	}
	if strings.TrimSpace(input.ReturnURL) != "" {
		params.ReturnURL = stripe.String(strings.TrimSpace(input.ReturnURL))
	}
	params.Context = ctx
	result, err := billingportalsession.New(params)
	if err != nil {
		return "", err
	}
	return result.URL, nil
}

// CancelSubscription immediately cancels a subscription, stopping all future
// recurring charges. Used to reconcile a duplicate paid subscription.
func (c *stripeBillingClient) CancelSubscription(ctx context.Context, subscriptionID string) error {
	c.withKey()
	params := &stripe.SubscriptionCancelParams{}
	params.Context = ctx
	_, err := subscription.Cancel(strings.TrimSpace(subscriptionID), params)
	return err
}

// UpdateSubscriptionQuantity sets the seat quantity on a subscription's single
// line item, with prorations, so per-seat billing tracks org membership.
func (c *stripeBillingClient) UpdateSubscriptionQuantity(ctx context.Context, subscriptionID string, quantity int64) error {
	c.withKey()
	getParams := &stripe.SubscriptionParams{}
	getParams.Context = ctx
	current, err := subscription.Get(strings.TrimSpace(subscriptionID), getParams)
	if err != nil {
		return err
	}
	if current.Items == nil || len(current.Items.Data) == 0 {
		return fmt.Errorf("stripe subscription %s has no line items", strings.TrimSpace(subscriptionID))
	}
	item := current.Items.Data[0]
	if item.Quantity == quantity {
		return nil
	}
	params := &stripe.SubscriptionParams{
		Items: []*stripe.SubscriptionItemsParams{
			{
				ID:       stripe.String(item.ID),
				Quantity: stripe.Int64(quantity),
			},
		},
		ProrationBehavior: stripe.String("create_prorations"),
	}
	params.Context = ctx
	_, err = subscription.Update(current.ID, params)
	return err
}

// GetLatestCheckoutSession returns the customer's newest Checkout Session in
// any state. Billing uses its id as the next idempotency generation and its
// status to avoid creating another payable session after a completed checkout.
func (c *stripeBillingClient) GetLatestCheckoutSession(ctx context.Context, customerID string) (StripeCheckoutSessionSnapshot, bool, error) {
	c.withKey()
	params := &stripe.CheckoutSessionListParams{
		Customer: stripe.String(strings.TrimSpace(customerID)),
	}
	params.Context = ctx
	params.Limit = stripe.Int64(1)
	iter := checkoutsession.List(params)
	if !iter.Next() {
		if err := iter.Err(); err != nil {
			return StripeCheckoutSessionSnapshot{}, false, err
		}
		return StripeCheckoutSessionSnapshot{}, false, nil
	}
	session := iter.CheckoutSession()
	snapshot := StripeCheckoutSessionSnapshot{
		ID:       session.ID,
		URL:      session.URL,
		Status:   string(session.Status),
		Metadata: session.Metadata,
	}
	if session.Subscription != nil {
		snapshot.SubscriptionID = session.Subscription.ID
	}
	return snapshot, true, nil
}

// ExpireCheckoutSession voids an open checkout session so it can no longer be paid.
func (c *stripeBillingClient) ExpireCheckoutSession(ctx context.Context, sessionID string) error {
	c.withKey()
	params := &stripe.CheckoutSessionExpireParams{}
	params.Context = ctx
	_, err := checkoutsession.Expire(strings.TrimSpace(sessionID), params)
	return err
}

func (c *stripeBillingClient) GetSubscription(ctx context.Context, subscriptionID string) (StripeSubscriptionSnapshot, error) {
	c.withKey()
	params := &stripe.SubscriptionParams{}
	params.Context = ctx
	result, err := subscription.Get(strings.TrimSpace(subscriptionID), params)
	if err != nil {
		return StripeSubscriptionSnapshot{}, err
	}
	raw := []byte(nil)
	if result.LastResponse != nil {
		raw = result.LastResponse.RawJSON
	}
	snapshot := StripeSubscriptionSnapshot{
		ID:                result.ID,
		Status:            string(result.Status),
		CancelAtPeriodEnd: result.CancelAtPeriodEnd,
		Metadata:          result.Metadata,
		RawPayload:        raw,
	}
	if result.Customer != nil {
		snapshot.CustomerID = result.Customer.ID
	}
	if result.Customer == nil {
		snapshot.CustomerID = ""
	}
	if result.CanceledAt > 0 {
		snapshot.CanceledAt = time.Unix(result.CanceledAt, 0).UTC()
	}
	if result.TrialEnd > 0 {
		snapshot.TrialEnd = time.Unix(result.TrialEnd, 0).UTC()
	}
	if len(result.Items.Data) > 0 {
		item := result.Items.Data[0]
		snapshot.Quantity = item.Quantity
		snapshot.CurrentPeriodStart = time.Unix(item.CurrentPeriodStart, 0).UTC()
		snapshot.CurrentPeriodEnd = time.Unix(item.CurrentPeriodEnd, 0).UTC()
		if item.Price != nil {
			snapshot.PriceID = item.Price.ID
			if item.Price.Recurring != nil {
				snapshot.Interval = normalizeStripeInterval(string(item.Price.Recurring.Interval))
			}
		}
	}
	if snapshot.Quantity <= 0 {
		snapshot.Quantity = 1
	}
	return snapshot, nil
}

func (c *stripeBillingClient) GetCharge(ctx context.Context, chargeID string) (StripeChargeSnapshot, error) {
	c.withKey()
	params := &stripe.ChargeParams{}
	params.Context = ctx
	result, err := stripecharge.Get(strings.TrimSpace(chargeID), params)
	if err != nil {
		return StripeChargeSnapshot{}, err
	}
	snapshot := StripeChargeSnapshot{
		ID:             result.ID,
		AmountRefunded: result.AmountRefunded,
		Currency:       string(result.Currency),
	}
	if result.Customer != nil {
		snapshot.CustomerID = result.Customer.ID
	}
	if result.PaymentIntent != nil {
		snapshot.PaymentIntent = result.PaymentIntent.ID
	}
	return snapshot, nil
}

func (c *stripeBillingClient) ListActiveEntitlements(ctx context.Context, customerID string) ([]string, error) {
	c.withKey()
	params := &stripe.EntitlementsActiveEntitlementListParams{
		Customer: stripe.String(strings.TrimSpace(customerID)),
	}
	params.Context = ctx
	iter := activeentitlement.List(params)
	var out []string
	for iter.Next() {
		entitlement := iter.EntitlementsActiveEntitlement()
		if entitlement == nil {
			continue
		}
		key := strings.TrimSpace(entitlement.LookupKey)
		if key == "" && entitlement.Feature != nil {
			key = strings.TrimSpace(entitlement.Feature.LookupKey)
		}
		if key == "" {
			continue
		}
		out = append(out, key)
	}
	if err := iter.Err(); err != nil {
		return nil, err
	}
	return dedupeStrings(out), nil
}
