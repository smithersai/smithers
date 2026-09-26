package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// The Pro plan is the $50/mo single-user tier in the shared catalog: it
// must be purchasable by a USER owner (unlike team/enterprise, which are
// org-only), resolve to the configured pro price ids, and map back from a
// Stripe price to the pro plan on webhook projection.

func proBillingService(client StripeBillingClient) *BillingService {
	return NewBillingService(newBillingQuerierMock(), client, BillingServiceConfig{
		BaseURL:                "https://smithers.test",
		PersonalMonthlyPriceID: "price_personal_monthly",
		ProMonthlyPriceID:      "price_pro_monthly",
		ProAnnualPriceID:       "price_pro_annual",
	})
}

func TestBillingService_CreateUserCheckout_ProPlan(t *testing.T) {
	t.Parallel()

	var gotCheckout StripeCreateCheckoutSessionInput
	client := &stripeBillingClientMock{
		createCustomerFn: func(_ context.Context, _ StripeCreateCustomerInput) (string, error) {
			return "cus_pro_1", nil
		},
		createCheckoutFn: func(_ context.Context, input StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error) {
			gotCheckout = input
			return StripeCheckoutSessionResult{ID: "cs_pro_1", URL: "https://checkout.stripe.test/pro"}, nil
		},
	}
	svc := proBillingService(client)

	user := &db.User{
		ID:          7,
		Username:    "ada",
		DisplayName: "Ada",
		Email:       pgtype.Text{String: "ada@example.com", Valid: true},
	}
	result, err := svc.CreateUserCheckout(context.Background(), user, BillingPlanPro, BillingIntervalMonthly)
	require.NoError(t, err)
	assert.Equal(t, "https://checkout.stripe.test/pro", result.URL)
	assert.Equal(t, "price_pro_monthly", gotCheckout.PriceID)
	assert.Equal(t, int64(1), gotCheckout.Quantity)
	assert.Equal(t, BillingPlanPro, gotCheckout.Metadata["plan_key"])

	// Annual is refused even with an annual price configured.
	_, err = svc.CreateUserCheckout(context.Background(), user, BillingPlanPro, BillingIntervalAnnual)
	assert.Equal(t, 400, httpStatus(err))
}

func TestBillingService_CheckoutPlan_ProIsUserOnlyAndNeedsAPrice(t *testing.T) {
	t.Parallel()

	svc := proBillingService(&stripeBillingClientMock{})

	// Pro is registered for USER owners only — an org checkout must refuse.
	_, err := svc.checkoutPlan(BillingOwnerTypeOrg, BillingPlanPro, BillingIntervalMonthly)
	require.Error(t, err)

	// Without a configured price id the plan is not sellable (honest 400).
	unpriced := NewBillingService(newBillingQuerierMock(), &stripeBillingClientMock{}, BillingServiceConfig{
		BaseURL: "https://smithers.test",
	})
	_, err = unpriced.checkoutPlan(BillingOwnerTypeUser, BillingPlanPro, BillingIntervalMonthly)
	require.Error(t, err)
}

func TestBillingService_PlanFromPrice_MapsProPriceBack(t *testing.T) {
	t.Parallel()

	svc := proBillingService(&stripeBillingClientMock{})
	plan := svc.planFromPrice(BillingOwnerTypeUser, "price_pro_monthly", BillingIntervalMonthly)
	assert.Equal(t, BillingPlanPro, plan.Key)
	assert.Equal(t, int64(1), plan.Limits.Seats)
	assert.Equal(t, int64(15000), plan.Limits.AgentRuns)
}

// querierWithActiveSub overrides the latest-subscription lookup so the
// double-subscription guard path is exercised against a paid subscription.
type querierWithActiveSub struct {
	*billingQuerierMock
	status string
}

func (q *querierWithActiveSub) GetLatestBillingSubscriptionByAccount(context.Context, int64) (db.BillingSubscription, error) {
	return db.BillingSubscription{ID: 9, Status: q.status, PlanKey: BillingPlanPersonal}, nil
}

func (q *querierWithActiveSub) GetLatestLiveBillingSubscriptionByAccount(context.Context, int64) (db.BillingSubscription, error) {
	if !paidSubscriptionStatus(q.status) {
		return db.BillingSubscription{}, pgx.ErrNoRows
	}
	return db.BillingSubscription{ID: 9, Status: q.status, PlanKey: BillingPlanPersonal}, nil
}

func TestBillingService_CreateUserCheckout_RefusesSecondSubscription(t *testing.T) {
	t.Parallel()

	client := &stripeBillingClientMock{
		createCustomerFn: func(_ context.Context, _ StripeCreateCustomerInput) (string, error) {
			return "cus_guard_1", nil
		},
		createCheckoutFn: func(_ context.Context, _ StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error) {
			t.Fatal("checkout session must not be created while a paid subscription exists")
			return StripeCheckoutSessionResult{}, nil
		},
	}
	svc := NewBillingService(
		&querierWithActiveSub{billingQuerierMock: newBillingQuerierMock(), status: "active"},
		client,
		BillingServiceConfig{BaseURL: "https://smithers.test", ProMonthlyPriceID: "price_pro_monthly"},
	)
	user := &db.User{ID: 8, Username: "grace", DisplayName: "Grace"}
	_, err := svc.CreateUserCheckout(context.Background(), user, BillingPlanPro, BillingIntervalMonthly)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "billing portal")
}

func TestBillingService_CreateUserCheckout_CanceledSubscriptionMayBuyAgain(t *testing.T) {
	t.Parallel()

	created := 0
	client := &stripeBillingClientMock{
		createCustomerFn: func(_ context.Context, _ StripeCreateCustomerInput) (string, error) {
			return "cus_guard_2", nil
		},
		createCheckoutFn: func(_ context.Context, _ StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error) {
			created++
			return StripeCheckoutSessionResult{ID: "cs_again", URL: "https://checkout.stripe.test/again"}, nil
		},
	}
	svc := NewBillingService(
		&querierWithActiveSub{billingQuerierMock: newBillingQuerierMock(), status: "canceled"},
		client,
		BillingServiceConfig{BaseURL: "https://smithers.test", ProMonthlyPriceID: "price_pro_monthly"},
	)
	user := &db.User{ID: 9, Username: "lin", DisplayName: "Lin"}
	_, err := svc.CreateUserCheckout(context.Background(), user, BillingPlanPro, BillingIntervalMonthly)
	require.NoError(t, err)
	assert.Equal(t, 1, created)
}

func TestBillingService_CheckoutPlan_RejectsUnknownInterval(t *testing.T) {
	t.Parallel()

	svc := proBillingService(&stripeBillingClientMock{})
	_, err := svc.checkoutPlan(BillingOwnerTypeUser, BillingPlanPro, "yearly")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unsupported billing interval")

	// The documented aliases still resolve, and annual is not offered.
	plan, err := svc.checkoutPlan(BillingOwnerTypeUser, BillingPlanPro, "month")
	require.NoError(t, err)
	assert.Equal(t, "price_pro_monthly", plan.PriceID)
	_, err = svc.checkoutPlan(BillingOwnerTypeUser, BillingPlanPro, "year")
	assert.ErrorContains(t, err, "annual billing is not offered")
}
