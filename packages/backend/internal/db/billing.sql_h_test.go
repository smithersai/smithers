package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLFSUploadReservationCleanupQueryIsBounded(t *testing.T) {
	t.Parallel()
	assert.Contains(t, listExpiredLFSUploadReservationsByOwner, "LIMIT 256")
}

func TestBillingSQL_H_AccountsCreditsUsageAndSubscriptionsRoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	periodStart := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	periodEnd := periodStart.AddDate(0, 1, 0)

	account, err := q.UpsertBillingAccount(ctx, UpsertBillingAccountParams{
		OwnerType:           "user",
		OwnerID:             userID,
		StripeCustomerID:    "cus_h_" + randSlug(t),
		StripeCustomerEmail: "billing-h@example.com",
		StripeCustomerName:  "Billing H",
	})
	require.NoError(t, err)
	assert.Equal(t, userID, account.OwnerID)

	account, err = q.UpsertBillingAccount(ctx, UpsertBillingAccountParams{
		OwnerType:           "user",
		OwnerID:             userID,
		StripeCustomerID:    account.StripeCustomerID,
		StripeCustomerEmail: "billing-h-updated@example.com",
		StripeCustomerName:  "Billing H Updated",
	})
	require.NoError(t, err)
	assert.Equal(t, "billing-h-updated@example.com", account.StripeCustomerEmail)

	byOwner, err := q.GetBillingAccountByOwner(ctx, GetBillingAccountByOwnerParams{OwnerType: "user", OwnerID: userID})
	require.NoError(t, err)
	assert.Equal(t, account.ID, byOwner.ID)
	byCustomer, err := q.GetBillingAccountByStripeCustomerID(ctx, account.StripeCustomerID)
	require.NoError(t, err)
	assert.Equal(t, account.ID, byCustomer.ID)

	claimed, err := q.ClaimStripeProcessedEvent(ctx, ClaimStripeProcessedEventParams{EventID: "evt_h_" + randSlug(t), EventType: "customer.subscription.updated"})
	require.NoError(t, err)
	assert.NotEmpty(t, claimed)
	_, err = q.ClaimStripeProcessedEvent(ctx, ClaimStripeProcessedEventParams{EventID: claimed, EventType: "customer.subscription.updated"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	require.NoError(t, q.DeleteStripeProcessedEvent(ctx, claimed))
	claimedAgain, err := q.ClaimStripeProcessedEvent(ctx, ClaimStripeProcessedEventParams{EventID: claimed, EventType: "customer.subscription.updated"})
	require.NoError(t, err)
	assert.Equal(t, claimed, claimedAgain)

	balance, err := q.UpsertCreditBalance(ctx, UpsertCreditBalanceParams{
		BillingAccountID: account.ID,
		BalanceCents:     2500,
		LastGrantAt:      pgtype.Timestamptz{Time: periodStart, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(2500), balance.BalanceCents)
	gotBalance, err := q.GetCreditBalance(ctx, account.ID)
	require.NoError(t, err)
	assert.Equal(t, balance.BalanceCents, gotBalance.BalanceCents)

	ledger, err := q.InsertCreditLedgerEntry(ctx, InsertCreditLedgerEntryParams{
		BillingAccountID:  account.ID,
		AmountCents:       2500,
		BalanceAfterCents: 2500,
		Reason:            "monthly grant",
		Category:          "monthly_grant",
		MetricKey:         "",
		IdempotencyKey:    "grant-h-" + randSlug(t),
	})
	require.NoError(t, err)
	ledgerCount, err := q.CountCreditLedgerByAccount(ctx, account.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), ledgerCount)
	ledgerByKey, err := q.GetCreditLedgerByIdempotencyKey(ctx, GetCreditLedgerByIdempotencyKeyParams{
		BillingAccountID: account.ID,
		IdempotencyKey:   ledger.IdempotencyKey,
	})
	require.NoError(t, err)
	assert.Equal(t, ledger.ID, ledgerByKey.ID)
	ledgerRows, err := q.ListCreditLedgerByAccount(ctx, ListCreditLedgerByAccountParams{BillingAccountID: account.ID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, ledgerRows, 1)

	usage, err := q.UpsertBillingUsageCounter(ctx, UpsertBillingUsageCounterParams{
		OwnerType:                "user",
		OwnerID:                  userID,
		MetricKey:                "workflow_minutes",
		PeriodStart:              periodStart,
		PeriodEnd:                periodEnd,
		IncludedQuantity:         100,
		ConsumedQuantity:         10,
		OverageQuantity:          0,
		LastReportedMeterEventID: "meter-h-1",
		LastSyncedAt:             periodStart.Add(time.Hour),
	})
	require.NoError(t, err)
	assert.Equal(t, int64(10), usage.ConsumedQuantity)
	usage, err = q.IncrementUsageCounter(ctx, IncrementUsageCounterParams{
		OwnerType:        "user",
		OwnerID:          userID,
		MetricKey:        "workflow_minutes",
		PeriodStart:      periodStart,
		PeriodEnd:        periodEnd,
		IncludedQuantity: 100,
		ConsumedQuantity: 5,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(15), usage.ConsumedQuantity)
	gotUsage, err := q.GetUsageCounterByMetric(ctx, GetUsageCounterByMetricParams{
		OwnerType: "user", OwnerID: userID, MetricKey: "workflow_minutes", PeriodStart: periodStart, PeriodEnd: periodEnd,
	})
	require.NoError(t, err)
	assert.Equal(t, usage.ID, gotUsage.ID)
	usageRows, err := q.ListBillingUsageCountersByOwnerAndPeriod(ctx, ListBillingUsageCountersByOwnerAndPeriodParams{
		OwnerType: "user", OwnerID: userID, PeriodStart: periodStart, PeriodEnd: periodEnd,
	})
	require.NoError(t, err)
	require.Len(t, usageRows, 1)

	entitlement, err := q.UpsertBillingEntitlement(ctx, UpsertBillingEntitlementParams{
		BillingAccountID: account.ID,
		FeatureKey:       "private_repos",
		Active:           true,
		LastSyncedAt:     periodStart.Add(2 * time.Hour),
	})
	require.NoError(t, err)
	assert.True(t, entitlement.Active)
	entitlements, err := q.ListBillingEntitlementsByAccount(ctx, account.ID)
	require.NoError(t, err)
	require.Len(t, entitlements, 1)
	require.NoError(t, q.DeactivateBillingEntitlementsByAccount(ctx, account.ID))
	entitlements, err = q.ListBillingEntitlementsByAccount(ctx, account.ID)
	require.NoError(t, err)
	require.Len(t, entitlements, 1)
	assert.False(t, entitlements[0].Active)

	activeSub, err := q.UpsertBillingSubscription(ctx, UpsertBillingSubscriptionParams{
		BillingAccountID:     account.ID,
		StripeSubscriptionID: "sub_h_active_" + randSlug(t),
		StripePriceID:        "price_monthly",
		PlanKey:              "pro",
		BillingInterval:      "monthly",
		Status:               "active",
		Quantity:             1,
		CurrentPeriodStart:   pgtype.Timestamptz{Time: periodStart, Valid: true},
		CurrentPeriodEnd:     pgtype.Timestamptz{Time: periodEnd, Valid: true},
		RawPayload:           json.RawMessage(`{"status":"active"}`),
	})
	require.NoError(t, err)
	canceledSub, err := q.UpsertBillingSubscription(ctx, UpsertBillingSubscriptionParams{
		BillingAccountID:     account.ID,
		StripeSubscriptionID: "sub_h_canceled_" + randSlug(t),
		StripePriceID:        "price_monthly",
		PlanKey:              "pro",
		BillingInterval:      "monthly",
		Status:               "canceled",
		Quantity:             1,
		CurrentPeriodStart:   pgtype.Timestamptz{Time: periodStart, Valid: true},
		CurrentPeriodEnd:     pgtype.Timestamptz{Time: periodEnd, Valid: true},
		CanceledAt:           pgtype.Timestamptz{Time: periodStart.Add(24 * time.Hour), Valid: true},
		RawPayload:           json.RawMessage(`{"status":"canceled"}`),
	})
	require.NoError(t, err)
	subscriptions, err := q.ListBillingSubscriptionsByAccount(ctx, account.ID)
	require.NoError(t, err)
	require.Len(t, subscriptions, 2)
	latestSub, err := q.GetLatestBillingSubscriptionByAccount(ctx, account.ID)
	require.NoError(t, err)
	assert.Equal(t, canceledSub.ID, latestSub.ID)
	liveSub, err := q.GetLatestLiveBillingSubscriptionByAccount(ctx, account.ID)
	require.NoError(t, err)
	assert.Equal(t, activeSub.ID, liveSub.ID)

	pastDueSub, err := q.UpsertBillingSubscription(ctx, UpsertBillingSubscriptionParams{
		BillingAccountID:     account.ID,
		StripeSubscriptionID: activeSub.StripeSubscriptionID,
		StripePriceID:        activeSub.StripePriceID,
		PlanKey:              activeSub.PlanKey,
		BillingInterval:      activeSub.BillingInterval,
		Status:               "past_due",
		Quantity:             activeSub.Quantity,
		CurrentPeriodStart:   activeSub.CurrentPeriodStart,
		CurrentPeriodEnd:     pgtype.Timestamptz{Time: periodEnd.AddDate(0, 1, 0), Valid: true},
		RawPayload:           json.RawMessage(`{"status":"past_due"}`),
	})
	require.NoError(t, err)
	require.True(t, pastDueSub.PastDueSince.Valid)
	firstPastDueSince := pastDueSub.PastDueSince.Time

	replayedPastDue, err := q.UpsertBillingSubscription(ctx, UpsertBillingSubscriptionParams{
		BillingAccountID:     account.ID,
		StripeSubscriptionID: activeSub.StripeSubscriptionID,
		StripePriceID:        activeSub.StripePriceID,
		PlanKey:              activeSub.PlanKey,
		BillingInterval:      activeSub.BillingInterval,
		Status:               "past_due",
		Quantity:             activeSub.Quantity,
		CurrentPeriodStart:   activeSub.CurrentPeriodStart,
		CurrentPeriodEnd:     pgtype.Timestamptz{Time: periodEnd.AddDate(0, 2, 0), Valid: true},
		RawPayload:           json.RawMessage(`{"status":"past_due"}`),
	})
	require.NoError(t, err)
	assert.Equal(t, firstPastDueSince, replayedPastDue.PastDueSince.Time,
		"replayed dunning webhooks must not extend the grace anchor")

	activeSub, err = q.UpsertBillingSubscription(ctx, UpsertBillingSubscriptionParams{
		BillingAccountID:     account.ID,
		StripeSubscriptionID: activeSub.StripeSubscriptionID,
		StripePriceID:        activeSub.StripePriceID,
		PlanKey:              activeSub.PlanKey,
		BillingInterval:      activeSub.BillingInterval,
		Status:               "active",
		Quantity:             activeSub.Quantity,
		CurrentPeriodStart:   activeSub.CurrentPeriodStart,
		CurrentPeriodEnd:     activeSub.CurrentPeriodEnd,
		RawPayload:           json.RawMessage(`{"status":"active"}`),
	})
	require.NoError(t, err)
	assert.False(t, activeSub.PastDueSince.Valid, "recovery clears the delinquency transition")

	allAccounts, err := q.ListAllActiveBillingAccounts(ctx)
	require.NoError(t, err)
	assert.True(t, billingSQLHHasAccount(allAccounts, account.ID))

	privateRepoName := "billing-private-" + randSlug(t)
	_, err = q.CreateRepo(ctx, CreateRepoParams{
		UserID:          pgtype.Int8{Int64: userID, Valid: true},
		Name:            privateRepoName,
		LowerName:       privateRepoName,
		Description:     "private",
		StorageSetID:    "s1",
		IsPublic:        false,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)
	privateCount, err := q.CountPrivateReposByOwner(ctx, CountPrivateReposByOwnerParams{OwnerType: "user", OwnerID: userID})
	require.NoError(t, err)
	assert.Equal(t, int64(1), privateCount)

	workflowRun := billingSQLHCreateWorkflowRun(t, q, pool, repoID, "agent_message", periodStart.Add(10*time.Minute), periodStart.Add(13*time.Minute))
	billingSQLHStartAgentTask(t, pool, workflowRun, periodStart.Add(10*time.Minute))
	// An agent dispatch that failed during infrastructure provisioning (its
	// task never started) must not consume the monthly agent-run quota.
	billingSQLHCreateWorkflowRun(t, q, pool, repoID, "agent_message", periodStart.Add(20*time.Minute), periodStart.Add(21*time.Minute))
	agentRuns, err := q.CountAgentRunsByOwner(ctx, CountAgentRunsByOwnerParams{
		PeriodStart: periodStart, PeriodEnd: periodEnd, OwnerType: "user", OwnerID: userID,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), agentRuns)
	workflowMinutes, err := q.SumWorkflowMinutesByOwner(ctx, SumWorkflowMinutesByOwnerParams{
		PeriodStart: periodStart, PeriodEnd: periodEnd, OwnerType: "user", OwnerID: userID,
	})
	require.NoError(t, err)
	assert.GreaterOrEqual(t, workflowMinutes, int64(3))
	assert.NotZero(t, workflowRun.ID)

	mustExec(t, pool, `INSERT INTO lfs_objects (repository_id, oid, size, gcs_path) VALUES ($1, $2, $3, $4)`, repoID, "oid-h-"+randSlug(t), int64(1234), "gcs/h")
	storageBytes, err := q.SumStorageBytesByOwner(ctx, SumStorageBytesByOwnerParams{OwnerType: "user", OwnerID: userID})
	require.NoError(t, err)
	assert.Equal(t, int64(1234), storageBytes)
	repositoryStorageBytes, err := q.SumStorageBytesByRepository(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, storageBytes, repositoryStorageBytes)

	reservationOID := "reservation-" + randSlug(t)
	_, err = q.UpsertLFSUploadReservation(ctx, UpsertLFSUploadReservationParams{
		RepositoryID: repoID,
		Oid:          reservationOID,
		Size:         66,
		ExpiresAt:    time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	expiredReservationOID := "expired-" + randSlug(t)
	_, err = q.UpsertLFSUploadReservation(ctx, UpsertLFSUploadReservationParams{
		RepositoryID: repoID,
		Oid:          expiredReservationOID,
		Size:         999,
		ExpiresAt:    time.Now().Add(-time.Hour),
	})
	require.NoError(t, err)
	storageBytes, err = q.SumStorageBytesByOwner(ctx, SumStorageBytesByOwnerParams{OwnerType: "user", OwnerID: userID})
	require.NoError(t, err)
	assert.Equal(t, int64(2299), storageBytes, "expired reservations remain counted until physical cleanup is confirmed")
	repositoryStorageBytes, err = q.SumStorageBytesByRepository(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, storageBytes, repositoryStorageBytes)
	require.NoError(t, q.DeleteLFSUploadReservation(ctx, DeleteLFSUploadReservationParams{RepositoryID: repoID, Oid: reservationOID}))
	storageBytes, err = q.SumStorageBytesByOwner(ctx, SumStorageBytesByOwnerParams{OwnerType: "user", OwnerID: userID})
	require.NoError(t, err)
	assert.Equal(t, int64(2299), storageBytes, "metadata deletion alone must retain the physical-storage billing fence")
	for _, objectKey := range []string{
		fmt.Sprintf("lfs-pending/%d/%s", repoID, reservationOID),
		fmt.Sprintf("repos/%d/lfs/%s", repoID, reservationOID),
	} {
		cleared, clearErr := q.ClearPurgedStorageDeletionByExactKey(ctx, ClearPurgedStorageDeletionByExactKeyParams{
			RepositoryID:  repoID,
			AllocationKey: fmt.Sprintf("lfs:%d:%s", repoID, reservationOID),
			ObjectKey:     objectKey,
		})
		require.NoError(t, clearErr)
		assert.Equal(t, int64(1), cleared)
	}
	storageBytes, err = q.SumStorageBytesByOwner(ctx, SumStorageBytesByOwnerParams{OwnerType: "user", OwnerID: userID})
	require.NoError(t, err)
	assert.Equal(t, int64(2233), storageBytes)
	deleted, err := q.DeleteExpiredLFSUploadReservation(ctx, DeleteExpiredLFSUploadReservationParams{RepositoryID: repoID, Oid: expiredReservationOID})
	require.NoError(t, err)
	assert.Equal(t, int64(1), deleted)
	storageBytes, err = q.SumStorageBytesByOwner(ctx, SumStorageBytesByOwnerParams{OwnerType: "user", OwnerID: userID})
	require.NoError(t, err)
	assert.Equal(t, int64(2233), storageBytes, "expired metadata cleanup remains billable until both exact keys are purged")
	for _, objectKey := range []string{
		fmt.Sprintf("lfs-pending/%d/%s", repoID, expiredReservationOID),
		fmt.Sprintf("repos/%d/lfs/%s", repoID, expiredReservationOID),
	} {
		cleared, clearErr := q.ClearPurgedStorageDeletionByExactKey(ctx, ClearPurgedStorageDeletionByExactKeyParams{
			RepositoryID:  repoID,
			AllocationKey: fmt.Sprintf("lfs:%d:%s", repoID, expiredReservationOID),
			ObjectKey:     objectKey,
		})
		require.NoError(t, clearErr)
		assert.Equal(t, int64(1), cleared)
	}
	storageBytes, err = q.SumStorageBytesByOwner(ctx, SumStorageBytesByOwnerParams{OwnerType: "user", OwnerID: userID})
	require.NoError(t, err)
	assert.Equal(t, int64(1234), storageBytes)
	repositoryStorageBytes, err = q.SumStorageBytesByRepository(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, storageBytes, repositoryStorageBytes)
}

func TestBillingSQL_H_MissingRowsAndConstraintErrors(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))
	account := billingSQLHCreateAccount(t, q, userID)

	_, err := q.GetBillingAccountByOwner(ctx, GetBillingAccountByOwnerParams{OwnerType: "user", OwnerID: 999999999})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetBillingAccountByStripeCustomerID(ctx, "missing")
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetCreditBalance(ctx, account.ID)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetCreditLedgerByIdempotencyKey(ctx, GetCreditLedgerByIdempotencyKeyParams{BillingAccountID: account.ID, IdempotencyKey: "missing"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetLatestBillingSubscriptionByAccount(ctx, account.ID)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetLatestLiveBillingSubscriptionByAccount(ctx, account.ID)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetUsageCounterByMetric(ctx, GetUsageCounterByMetricParams{
		OwnerType: "user", OwnerID: userID, MetricKey: "missing", PeriodStart: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), PeriodEnd: time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC),
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.UpsertBillingAccount(ctx, UpsertBillingAccountParams{
			OwnerType: "team", OwnerID: userID, StripeCustomerID: "cus_bad_" + randSlug(t),
		})
		return err
	})
	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.UpsertBillingUsageCounter(ctx, UpsertBillingUsageCounterParams{
			OwnerType: "user", OwnerID: userID, MetricKey: "bad", PeriodStart: time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC), PeriodEnd: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		})
		return err
	})
	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.InsertCreditLedgerEntry(ctx, InsertCreditLedgerEntryParams{
			BillingAccountID: account.ID, AmountCents: 1, BalanceAfterCents: 1, Category: "not-a-category",
		})
		return err
	})
}

func TestBillingSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("billing h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListAllActiveBillingAccounts", func(q *Queries) error { _, err := q.ListAllActiveBillingAccounts(context.Background()); return err }},
		{"ListBillingEntitlementsByAccount", func(q *Queries) error {
			_, err := q.ListBillingEntitlementsByAccount(context.Background(), 1)
			return err
		}},
		{"ListBillingSubscriptionsByAccount", func(q *Queries) error {
			_, err := q.ListBillingSubscriptionsByAccount(context.Background(), 1)
			return err
		}},
		{"ListBillingUsageCountersByOwnerAndPeriod", func(q *Queries) error {
			_, err := q.ListBillingUsageCountersByOwnerAndPeriod(context.Background(), ListBillingUsageCountersByOwnerAndPeriodParams{
				OwnerType: "user", OwnerID: 1, PeriodStart: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), PeriodEnd: time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC),
			})
			return err
		}},
		{"ListCreditLedgerByAccount", func(q *Queries) error {
			_, err := q.ListCreditLedgerByAccount(context.Background(), ListCreditLedgerByAccountParams{BillingAccountID: 1, PageOffset: 0, PageSize: 1})
			return err
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			err := tc.call(New(billingSQLHDB{queryErr: sentinel}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			err := tc.call(New(billingSQLHDB{rows: &billingSQLHRows{next: true, scanErr: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			err := tc.call(New(billingSQLHDB{rows: &billingSQLHRows{err: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
	}
}

func TestBillingSQL_H_ExecErrorBranches(t *testing.T) {
	sentinel := errors.New("billing h exec failed")
	q := New(billingSQLHDB{execErr: sentinel})
	require.ErrorIs(t, q.DeactivateBillingEntitlementsByAccount(context.Background(), 1), sentinel)
	require.ErrorIs(t, q.DeleteStripeProcessedEvent(context.Background(), "evt"), sentinel)
}

func billingSQLHCreateAccount(t *testing.T, q *Queries, userID int64) BillingAccount {
	t.Helper()
	account, err := q.UpsertBillingAccount(context.Background(), UpsertBillingAccountParams{
		OwnerType:           "user",
		OwnerID:             userID,
		StripeCustomerID:    "cus_h_missing_" + randSlug(t),
		StripeCustomerEmail: "missing-h@example.com",
		StripeCustomerName:  "Missing H",
	})
	require.NoError(t, err)
	return account
}

func billingSQLHCreateWorkflowRun(t *testing.T, q *Queries, pool DBTX, repoID int64, triggerEvent string, startedAt, completedAt time.Time) WorkflowRun {
	t.Helper()
	def, err := q.UpsertWorkflowDefinition(context.Background(), UpsertWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Billing H",
		Path:         ".smithers/workflows/billing-h-" + randSlug(t) + ".yml",
		Config:       json.RawMessage(`{"billing":true}`),
	})
	require.NoError(t, err)
	run, err := q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "success",
		TriggerEvent:         triggerEvent,
		TriggerRef:           "main",
		TriggerCommitSha:     "sha-billing-h",
		DispatchInputs:       []byte(`{}`),
	})
	require.NoError(t, err)
	mustExec(t, pool, `UPDATE workflow_runs SET started_at = $1, completed_at = $2, created_at = $1 WHERE id = $3`, startedAt, completedAt, run.ID)
	return run
}

// billingSQLHStartAgentTask gives the run a task that actually started
// executing, which is what CountAgentRunsByOwner requires before a run
// consumes agent-run quota.
func billingSQLHStartAgentTask(t *testing.T, pool DBTX, run WorkflowRun, startedAt time.Time) {
	t.Helper()
	var stepID int64
	require.NoError(t, pool.QueryRow(context.Background(),
		`INSERT INTO workflow_steps (workflow_run_id, name, position, status) VALUES ($1, 'agent', 0, 'success') RETURNING id`,
		run.ID).Scan(&stepID))
	mustExec(t, pool,
		`INSERT INTO workflow_tasks (workflow_run_id, workflow_step_id, status, payload, started_at) VALUES ($1, $2, 'done', '{}'::jsonb, $3)`,
		run.ID, stepID, startedAt)
}

func billingSQLHHasAccount(accounts []BillingAccount, id int64) bool {
	for _, account := range accounts {
		if account.ID == id {
			return true
		}
	}
	return false
}

type billingSQLHDB struct {
	execErr  error
	queryErr error
	rows     pgx.Rows
	row      pgx.Row
}

func (db billingSQLHDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, db.execErr
}

func (db billingSQLHDB) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	if db.queryErr != nil {
		return nil, db.queryErr
	}
	if db.rows != nil {
		return db.rows, nil
	}
	return &billingSQLHRows{}, nil
}

func (db billingSQLHDB) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	if db.row != nil {
		return db.row
	}
	return billingSQLHRow{err: errors.New("billing h row failed")}
}

type billingSQLHRow struct {
	err error
}

func (r billingSQLHRow) Scan(...any) error {
	return r.err
}

type billingSQLHRows struct {
	next    bool
	scanErr error
	err     error
}

func (r *billingSQLHRows) Close() {}

func (r *billingSQLHRows) Err() error {
	return r.err
}

func (r *billingSQLHRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r *billingSQLHRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}

func (r *billingSQLHRows) Next() bool {
	if r.next {
		r.next = false
		return true
	}
	return false
}

func (r *billingSQLHRows) Scan(...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	return errors.New("billing h scan unexpectedly succeeded")
}

func (r *billingSQLHRows) Values() ([]any, error) {
	return nil, r.err
}

func (r *billingSQLHRows) RawValues() [][]byte {
	return nil
}

func (r *billingSQLHRows) Conn() *pgx.Conn {
	return nil
}
