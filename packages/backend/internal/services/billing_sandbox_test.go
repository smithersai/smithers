package services

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func sandboxTestBilling(plan string) (*BillingService, *billingQuerierMock) {
	q := newBillingQuerierMock()
	q.accountsByOwner[q.ownerKey(BillingOwnerTypeUser, 7)] = db.BillingAccount{ID: 1, OwnerType: BillingOwnerTypeUser, OwnerID: 7}
	q.getLatestSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{PlanKey: plan, StripePriceID: "price_" + plan, Status: "active", BillingInterval: BillingIntervalMonthly}, nil
	}
	svc := NewBillingService(q, nil, BillingServiceConfig{ProMonthlyPriceID: "price_pro", MaxMonthlyPriceID: "price_max"})
	if plan == BillingPlanFree {
		delete(q.accountsByOwner, q.ownerKey(BillingOwnerTypeUser, 7))
	}
	svc.now = func() time.Time { return time.Date(2026, 9, 15, 15, 0, 0, 0, time.FixedZone("local", -7*3600)) }
	return svc, q
}

func TestBillingService_AuthorizeSandboxStart(t *testing.T) {
	for _, tc := range []struct {
		name, plan, kind, upgrade string
		live                      int
		agents, seconds           int64
		dbError                   string
	}{
		{name: "free at cap", plan: "free", live: 1, kind: "concurrent_sandboxes", upgrade: "pro"},
		{name: "agent included", plan: "free", agents: 1, kind: "concurrent_sandboxes", upgrade: "pro"},
		{name: "pro under cap", plan: "pro", live: 1, agents: 1},
		{name: "hours exhausted", plan: "free", seconds: 14400, kind: "sandbox_hours_per_day", upgrade: "pro"},
		{name: "hours boundary below", plan: "free", seconds: 14399},
		{name: "paid hours unlimited", plan: "pro", seconds: 999999},
		{name: "pro at cap", plan: "pro", live: 3, kind: "concurrent_sandboxes", upgrade: "max"},
		{name: "max at cap", plan: "max", live: 64, kind: "concurrent_sandboxes"},
		{name: "live error", plan: "free", dbError: "live"},
		{name: "agent error", plan: "free", dbError: "agent"},
		{name: "usage error", plan: "free", dbError: "usage"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, q := sandboxTestBilling(tc.plan)
			failure := errors.New("database unavailable")
			q.countActiveSandboxesFn = func(context.Context, int64) (int, error) {
				if tc.dbError == "live" {
					return 0, failure
				}
				return tc.live, nil
			}
			q.countActiveAgentsFn = func(_ context.Context, id int64) (int64, error) {
				assert.Equal(t, int64(7), id)
				if tc.dbError == "agent" {
					return 0, failure
				}
				return tc.agents, nil
			}
			q.sumSandboxSecondsFn = func(_ context.Context, id int64, since time.Time) (int64, error) {
				assert.Equal(t, int64(7), id)
				assert.Equal(t, time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC), since)
				if tc.dbError == "usage" {
					return 0, failure
				}
				return tc.seconds, nil
			}
			err := svc.AuthorizeSandboxStart(context.Background(), 7)
			assert.Zero(t, q.usageUpsertCalls)
			if tc.dbError != "" {
				require.ErrorIs(t, err, failure)
				return
			}
			if tc.kind == "" {
				require.NoError(t, err)
				return
			}
			var api *pkgerrors.APIError
			require.ErrorAs(t, err, &api)
			assert.Equal(t, 402, api.Status)
			assert.Equal(t, pkgerrors.CodePlanLimitExceeded, api.Code)
			assert.Equal(t, pkgerrors.FaultUser, api.Fault)
			assert.Equal(t, tc.plan, api.PlanKey)
			assert.Equal(t, tc.kind, api.LimitKind)
			assert.Equal(t, tc.upgrade, api.UpgradePlanKey)
			require.NotNil(t, api.Remaining)
			assert.Zero(t, *api.Remaining)
			if tc.name == "free at cap" {
				assert.Equal(t, "Your Free plan allows 1 running sandbox. Upgrade to Pro for 3, or suspend one to continue.", api.Message)
			}
			if tc.name == "hours exhausted" {
				assert.Equal(t, "Your Free plan includes 4 sandbox-hours per day; you have used them. Upgrade to Pro for unlimited hours, or try again after 2026-09-16T00:00:00Z.", api.Message)
			}
		})
	}
	t.Run("nil policy", func(t *testing.T) {
		require.NoError(t, authorizeSandboxStartForUser(context.Background(), nil, 7))
		var svc *BillingService
		require.NoError(t, svc.AuthorizeSandboxStart(context.Background(), 7))
	})
}

func TestBillingService_MaxSubscriptionWithoutIntervalUsesMaxSandboxLimits(t *testing.T) {
	svc, q := sandboxTestBilling(BillingPlanMax)
	q.getLatestSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{PlanKey: BillingPlanMax, Status: "active"}, nil
	}

	entitlement, err := svc.SandboxEntitlement(context.Background(), 7)
	require.NoError(t, err)
	assert.Equal(t, int64(64), entitlement.ConcurrentSandboxes)
	assert.Zero(t, entitlement.IdleTimeoutSecs)
}

func TestBillingService_CountedSandboxResume(t *testing.T) {
	for _, tc := range []struct {
		name, plan      string
		live            int
		others          int64
		matches         bool
		seconds         int64
		resumeAllowed   bool
		newStartAllowed bool
	}{
		{name: "counted VM at Pro cap", plan: "pro", live: 3, others: 2, matches: true, resumeAllowed: true},
		{name: "stale running input now needs a new slot", plan: "pro", live: 3, others: 3, matches: true},
		{name: "wrong VM or owner refused", plan: "pro", live: 3, others: 2},
		{name: "downgraded plan still full after self", plan: "free", live: 3, others: 2, matches: true},
		{name: "daily hours still enforced", plan: "free", live: 1, others: 0, matches: true, seconds: 14400},
		{name: "one counted VM on Free", plan: "free", live: 1, others: 0, matches: true, resumeAllowed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, q := sandboxTestBilling(tc.plan)
			q.countActiveSandboxesFn = func(context.Context, int64) (int, error) { return tc.live, nil }
			q.countOtherSandboxResumeFn = func(context.Context, db.CountOtherActiveSandboxesForWorkspaceResumeParams) (db.CountOtherActiveSandboxesForWorkspaceResumeRow, error) {
				return db.CountOtherActiveSandboxesForWorkspaceResumeRow{Others: int32(tc.others), Matches: tc.matches}, nil
			}
			q.sumSandboxSecondsFn = func(context.Context, int64, time.Time) (int64, error) { return tc.seconds, nil }
			resumeErr := svc.AuthorizeCountedSandboxResume(context.Background(), 7, "ws", "vm")
			assert.Equal(t, tc.resumeAllowed, resumeErr == nil, "counted resume: %v", resumeErr)
			startErr := svc.AuthorizeSandboxStart(context.Background(), 7)
			assert.Equal(t, tc.newStartAllowed, startErr == nil, "new slot: %v", startErr)
		})
	}
}

func TestBillingService_ConcurrentCountedResumesDoNotAdmitANewSlot(t *testing.T) {
	svc, q := sandboxTestBilling(BillingPlanPro)
	q.countActiveSandboxesFn = func(context.Context, int64) (int, error) { return 3, nil }
	q.countOtherSandboxResumeFn = func(context.Context, db.CountOtherActiveSandboxesForWorkspaceResumeParams) (db.CountOtherActiveSandboxesForWorkspaceResumeRow, error) {
		return db.CountOtherActiveSandboxesForWorkspaceResumeRow{Others: 2, Matches: true}, nil
	}
	var group sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			results <- svc.AuthorizeCountedSandboxResume(context.Background(), 7, "ws", "vm")
		}()
	}
	group.Wait()
	close(results)
	for err := range results {
		require.NoError(t, err)
	}
	require.Error(t, svc.AuthorizeSandboxStart(context.Background(), 7))
}

func TestBillingService_SandboxMonthlyUsage(t *testing.T) {
	for _, plan := range []string{"free", "pro", "max"} {
		t.Run(plan, func(t *testing.T) {
			svc, q := sandboxTestBilling(plan)
			q.sumSandboxSecondsFn = func(_ context.Context, id int64, since time.Time) (int64, error) {
				assert.Equal(t, int64(7), id)
				assert.Equal(t, time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC), since)
				return 3601, nil
			}
			definition, err := svc.resolvePlan(context.Background(), billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 7})
			require.NoError(t, err)
			usage, err := svc.computeAndPersistUsage(context.Background(), billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 7}, definition.Limits)
			require.NoError(t, err)
			assert.Equal(t, int64(2), usage[BillingMetricSandboxHours].ConsumedQuantity)
			included := unlimitedBillingQuantity
			if plan == "free" {
				included = 120
			}
			assert.Equal(t, included, usage[BillingMetricSandboxHours].IncludedQuantity)
		})
	}
}

func TestBillingService_PlansAndMaxCheckout(t *testing.T) {
	var checkout StripeCreateCheckoutSessionInput
	client := &stripeBillingClientMock{createCustomerFn: func(context.Context, StripeCreateCustomerInput) (string, error) { return "cus_max", nil }, createCheckoutFn: func(_ context.Context, input StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error) {
		checkout = input
		return StripeCheckoutSessionResult{ID: "cs_max", URL: "https://checkout.stripe.test/max"}, nil
	}}
	svc := NewBillingService(newBillingQuerierMock(), client, BillingServiceConfig{ProMonthlyPriceID: "price_pro", MaxMonthlyPriceID: "price_max", MaxAnnualPriceID: "price_max_annual"})
	user := &db.User{ID: 7, Username: "ada"}
	plans, err := svc.GetUserPlans(context.Background(), user)
	require.NoError(t, err)
	require.Len(t, plans.Plans, 3)
	assert.Equal(t, "free", plans.CurrentPlanKey)
	for i, key := range []string{"free", "pro", "max"} {
		assert.Equal(t, key, plans.Plans[i].Key)
	}
	assert.Equal(t, int64(5000), plans.Plans[1].PriceCents)
	assert.Equal(t, int64(50000), plans.Plans[2].PriceCents)
	assert.Equal(t, int64(64), plans.Plans[2].Limits.ConcurrentSandboxes)
	assert.Equal(t, int64(-1), plans.Plans[2].Limits.HoursPerDay)
	assert.Zero(t, plans.Plans[2].Limits.IdleTimeoutSecs)
	assert.False(t, plans.Plans[0].CheckoutAvailable)
	assert.True(t, plans.Plans[2].CheckoutAvailable)
	for _, interval := range []string{BillingIntervalMonthly, BillingIntervalAnnual} {
		_, err = svc.CreateUserCheckout(context.Background(), user, BillingPlanMax, interval)
		require.NoError(t, err)
		expected := "price_max"
		if interval == BillingIntervalAnnual {
			expected = "price_max_annual"
		}
		assert.Equal(t, expected, checkout.PriceID)
		assert.Equal(t, "max", checkout.Metadata["plan_key"])
	}
	_, err = svc.checkoutPlan(BillingOwnerTypeOrg, BillingPlanMax, BillingIntervalMonthly)
	require.Error(t, err)
	svc.stripe = nil
	plans, err = svc.GetUserPlans(context.Background(), user)
	require.NoError(t, err)
	assert.False(t, plans.Plans[2].CheckoutAvailable)
	entitlement := SandboxEntitlement{HoursPerDay: -1}
	payload, err := json.Marshal(entitlement)
	require.NoError(t, err)
	assert.Contains(t, string(payload), `"hours_per_day":-1`)
}

func TestSandboxMeteringUnavailableFailsClosed(t *testing.T) {
	// Hide the new methods, as the concrete queries do before the metering lane lands.
	q := struct{ BillingBaseQuerier }{newBillingQuerierMock()}
	svc := NewBillingService(q, nil, BillingServiceConfig{})
	err := svc.AuthorizeSandboxStart(context.Background(), 7)
	require.ErrorContains(t, err, "sandbox metering store unavailable")
}

func TestAgentWorkspaceAdmissionDoesNotCountOwnReservation(t *testing.T) {
	denied := pkgerrors.New(pkgerrors.CodePlanLimitExceeded, "at cap including the agent reservation")
	policy := sandboxPolicyStub{err: denied}
	ctx := context.WithValue(context.Background(), sandboxStartAdmissionKey{}, int64(7))
	require.NoError(t, authorizeSandboxStartForUser(ctx, policy, 7))
	require.ErrorIs(t, authorizeSandboxStartForUser(ctx, policy, 8), denied)
	require.ErrorIs(t, authorizeSandboxStartForUser(context.Background(), policy, 7), denied)
}
