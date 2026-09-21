-- Product queries extracted from the transitional Plue source.

-- name: GetBillingAccountByOwner :one
SELECT *
FROM billing_accounts
WHERE owner_type = sqlc.arg(owner_type)
  AND owner_id = sqlc.arg(owner_id);


-- name: GetBillingAccountByStripeCustomerID :one
SELECT *
FROM billing_accounts
WHERE stripe_customer_id = sqlc.arg(stripe_customer_id);


-- name: UpsertBillingAccount :one
INSERT INTO billing_accounts (
    owner_type,
    owner_id,
    stripe_customer_id,
    stripe_customer_email,
    stripe_customer_name
)
VALUES (
    sqlc.arg(owner_type),
    sqlc.arg(owner_id),
    sqlc.arg(stripe_customer_id),
    sqlc.arg(stripe_customer_email),
    sqlc.arg(stripe_customer_name)
)
ON CONFLICT (owner_type, owner_id) DO UPDATE
SET stripe_customer_id = EXCLUDED.stripe_customer_id,
    stripe_customer_email = EXCLUDED.stripe_customer_email,
    stripe_customer_name = EXCLUDED.stripe_customer_name,
    updated_at = NOW()
RETURNING *;


-- name: UpsertBillingSubscription :one
INSERT INTO billing_subscriptions (
    billing_account_id,
    stripe_subscription_id,
    stripe_price_id,
    plan_key,
    billing_interval,
    status,
    quantity,
    trial_end,
    current_period_start,
    current_period_end,
    past_due_since,
    cancel_at_period_end,
    canceled_at,
    raw_payload
)
VALUES (
    sqlc.arg(billing_account_id),
    sqlc.arg(stripe_subscription_id),
    sqlc.arg(stripe_price_id),
    sqlc.arg(plan_key),
    sqlc.arg(billing_interval),
    sqlc.arg(status),
    sqlc.arg(quantity),
    sqlc.arg(trial_end),
    sqlc.arg(current_period_start),
    sqlc.arg(current_period_end),
    CASE WHEN sqlc.arg(status)::varchar = 'past_due' THEN NOW() ELSE NULL END,
    sqlc.arg(cancel_at_period_end),
    sqlc.arg(canceled_at),
    sqlc.arg(raw_payload)
)
ON CONFLICT (stripe_subscription_id) DO UPDATE
SET billing_account_id = EXCLUDED.billing_account_id,
    stripe_price_id = EXCLUDED.stripe_price_id,
    plan_key = EXCLUDED.plan_key,
    billing_interval = EXCLUDED.billing_interval,
    status = EXCLUDED.status,
    quantity = EXCLUDED.quantity,
    trial_end = EXCLUDED.trial_end,
    current_period_start = EXCLUDED.current_period_start,
    current_period_end = EXCLUDED.current_period_end,
    past_due_since = CASE
        WHEN EXCLUDED.status <> 'past_due' THEN NULL
        WHEN billing_subscriptions.status = 'past_due'
            THEN COALESCE(billing_subscriptions.past_due_since, billing_subscriptions.updated_at)
        ELSE EXCLUDED.past_due_since
    END,
    cancel_at_period_end = EXCLUDED.cancel_at_period_end,
    canceled_at = EXCLUDED.canceled_at,
    raw_payload = EXCLUDED.raw_payload,
    updated_at = NOW()
RETURNING *;


-- name: GetLatestBillingSubscriptionByAccount :one
SELECT *
FROM billing_subscriptions
WHERE billing_account_id = sqlc.arg(billing_account_id)
ORDER BY updated_at DESC, id DESC
LIMIT 1;


-- name: GetLatestLiveBillingSubscriptionByAccount :one
SELECT *
FROM billing_subscriptions
WHERE billing_account_id = sqlc.arg(billing_account_id)
  AND status IN ('trialing', 'active', 'past_due')
ORDER BY updated_at DESC, id DESC
LIMIT 1;


-- name: ListBillingSubscriptionsByAccount :many
SELECT *
FROM billing_subscriptions
WHERE billing_account_id = sqlc.arg(billing_account_id)
ORDER BY updated_at DESC, id DESC;


-- name: DeactivateBillingEntitlementsByAccount :exec
UPDATE billing_entitlements
SET active = FALSE,
    last_synced_at = NOW(),
    updated_at = NOW()
WHERE billing_account_id = sqlc.arg(billing_account_id);


-- name: UpsertBillingEntitlement :one
INSERT INTO billing_entitlements (
    billing_account_id,
    feature_key,
    active,
    last_synced_at
)
VALUES (
    sqlc.arg(billing_account_id),
    sqlc.arg(feature_key),
    sqlc.arg(active),
    sqlc.arg(last_synced_at)
)
ON CONFLICT (billing_account_id, feature_key) DO UPDATE
SET active = EXCLUDED.active,
    last_synced_at = EXCLUDED.last_synced_at,
    updated_at = NOW()
RETURNING *;


-- name: ListBillingEntitlementsByAccount :many
SELECT *
FROM billing_entitlements
WHERE billing_account_id = sqlc.arg(billing_account_id)
ORDER BY feature_key ASC;


-- name: UpsertBillingUsageCounter :one
INSERT INTO billing_usage_counters (
    owner_type,
    owner_id,
    metric_key,
    period_start,
    period_end,
    included_quantity,
    consumed_quantity,
    overage_quantity,
    last_reported_meter_event_id,
    last_synced_at
)
VALUES (
    sqlc.arg(owner_type),
    sqlc.arg(owner_id),
    sqlc.arg(metric_key),
    sqlc.arg(period_start),
    sqlc.arg(period_end),
    sqlc.arg(included_quantity),
    sqlc.arg(consumed_quantity),
    sqlc.arg(overage_quantity),
    sqlc.arg(last_reported_meter_event_id),
    sqlc.arg(last_synced_at)
)
ON CONFLICT (owner_type, owner_id, metric_key, period_start, period_end) DO UPDATE
SET included_quantity = EXCLUDED.included_quantity,
    consumed_quantity = EXCLUDED.consumed_quantity,
    overage_quantity = EXCLUDED.overage_quantity,
    last_reported_meter_event_id = EXCLUDED.last_reported_meter_event_id,
    last_synced_at = EXCLUDED.last_synced_at,
    updated_at = NOW()
RETURNING *;


-- name: ListBillingUsageCountersByOwnerAndPeriod :many
SELECT *
FROM billing_usage_counters
WHERE owner_type = sqlc.arg(owner_type)
  AND owner_id = sqlc.arg(owner_id)
  AND period_start = sqlc.arg(period_start)
  AND period_end = sqlc.arg(period_end)
ORDER BY metric_key ASC;


-- name: SumWorkflowMinutesByOwner :one
WITH owned_repos AS (
    SELECT id
    FROM repositories
    WHERE (
        sqlc.arg(owner_type)::text = 'user'
        AND user_id = sqlc.arg(owner_id)::bigint
    )
    OR (
        sqlc.arg(owner_type)::text = 'org'
        AND org_id = sqlc.arg(owner_id)::bigint
    )
)
SELECT COALESCE(SUM(
    GREATEST(
        CEIL(EXTRACT(EPOCH FROM (COALESCE(wr.completed_at, NOW()) - wr.started_at)) / 60.0),
        0
    )
), 0)::bigint
FROM workflow_runs wr
WHERE wr.repository_id IN (SELECT id FROM owned_repos)
  AND wr.created_at >= sqlc.arg(period_start)
  AND wr.created_at < sqlc.arg(period_end)
  AND wr.started_at IS NOT NULL;


-- name: CountAgentRunsByOwner :one
-- Counts only agent runs whose task actually started executing (the agent VM
-- came up), so dispatches that die during provisioning do not consume the
-- monthly agent-run quota. wr.started_at cannot be the filter here: the
-- infra-failure cleanup path stamps it via UpdateWorkflowRunStatusBasedOnTasks
-- even when no agent ever ran, whereas the task's started_at is only stamped
-- by MarkWorkflowTaskVMRunning after the agent service started.
WITH owned_repos AS (
    SELECT id
    FROM repositories
    WHERE (
        sqlc.arg(owner_type)::text = 'user'
        AND user_id = sqlc.arg(owner_id)::bigint
    )
    OR (
        sqlc.arg(owner_type)::text = 'org'
        AND org_id = sqlc.arg(owner_id)::bigint
    )
)
SELECT COUNT(*)::bigint
FROM workflow_runs wr
WHERE wr.repository_id IN (SELECT id FROM owned_repos)
  AND wr.trigger_event = 'agent_message'
  AND wr.created_at >= sqlc.arg(period_start)
  AND wr.created_at < sqlc.arg(period_end)
  AND EXISTS (
      SELECT 1
      FROM workflow_tasks wt
      WHERE wt.workflow_run_id = wr.id
        AND wt.started_at IS NOT NULL
  );

-- ========================
-- Credit ledger & balances
-- ========================


-- name: GetCreditBalance :one
SELECT billing_account_id, balance_cents, last_grant_at, updated_at
FROM billing_credit_balances
WHERE billing_account_id = sqlc.arg(billing_account_id);


-- name: UpsertCreditBalance :one
INSERT INTO billing_credit_balances (billing_account_id, balance_cents, last_grant_at, updated_at)
VALUES (sqlc.arg(billing_account_id), sqlc.arg(balance_cents), sqlc.arg(last_grant_at), NOW())
ON CONFLICT (billing_account_id) DO UPDATE
SET balance_cents = EXCLUDED.balance_cents,
    last_grant_at = EXCLUDED.last_grant_at,
    updated_at = NOW()
RETURNING *;


-- name: InsertCreditLedgerEntry :one
INSERT INTO billing_credit_ledger (
    billing_account_id,
    amount_cents,
    balance_after_cents,
    reason,
    category,
    metric_key,
    idempotency_key
)
VALUES (
    sqlc.arg(billing_account_id),
    sqlc.arg(amount_cents),
    sqlc.arg(balance_after_cents),
    sqlc.arg(reason),
    sqlc.arg(category),
    sqlc.arg(metric_key),
    sqlc.arg(idempotency_key)
)
RETURNING *;


-- name: ListCreditLedgerByAccount :many
SELECT *
FROM billing_credit_ledger
WHERE billing_account_id = sqlc.arg(billing_account_id)
ORDER BY created_at DESC
LIMIT sqlc.arg(page_size)::bigint
OFFSET sqlc.arg(page_offset)::bigint;


-- name: CountCreditLedgerByAccount :one
SELECT COUNT(*)::bigint
FROM billing_credit_ledger
WHERE billing_account_id = sqlc.arg(billing_account_id);


-- name: GetCreditLedgerByIdempotencyKey :one
SELECT *
FROM billing_credit_ledger
WHERE billing_account_id = sqlc.arg(billing_account_id)
  AND idempotency_key = sqlc.arg(idempotency_key)
  AND idempotency_key != '';


-- name: ListAllActiveBillingAccounts :many
SELECT id, owner_type, owner_id, stripe_customer_id, stripe_customer_email, stripe_customer_name, created_at, updated_at
FROM billing_accounts
ORDER BY id ASC;


-- name: GetUsageCounterByMetric :one
SELECT *
FROM billing_usage_counters
WHERE owner_type = sqlc.arg(owner_type)
  AND owner_id = sqlc.arg(owner_id)
  AND metric_key = sqlc.arg(metric_key)
  AND period_start = sqlc.arg(period_start)
  AND period_end = sqlc.arg(period_end);


-- name: IncrementUsageCounter :one
INSERT INTO billing_usage_counters (
    owner_type,
    owner_id,
    metric_key,
    period_start,
    period_end,
    included_quantity,
    consumed_quantity,
    overage_quantity,
    last_reported_meter_event_id,
    last_synced_at
)
VALUES (
    sqlc.arg(owner_type),
    sqlc.arg(owner_id),
    sqlc.arg(metric_key),
    sqlc.arg(period_start),
    sqlc.arg(period_end),
    sqlc.arg(included_quantity),
    sqlc.arg(consumed_quantity),
    0,
    '',
    NOW()
)
ON CONFLICT (owner_type, owner_id, metric_key, period_start, period_end) DO UPDATE
SET consumed_quantity = billing_usage_counters.consumed_quantity + sqlc.arg(consumed_quantity),
    updated_at = NOW()
RETURNING *;

-- ========================
-- Stripe webhook idempotency
-- ========================


-- name: ClaimStripeProcessedEvent :one
INSERT INTO stripe_processed_events (event_id, event_type)
VALUES (sqlc.arg(event_id), sqlc.arg(event_type))
ON CONFLICT (event_id) DO NOTHING
RETURNING event_id;


-- name: DeleteStripeProcessedEvent :exec
DELETE FROM stripe_processed_events
WHERE event_id = sqlc.arg(event_id);
