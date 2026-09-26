-- A refund or dispute on an account's charge suspends its subscriptions' paid
-- entitlements even while the payment provider still reports them active.
-- UpsertBillingSubscription does not write this column, so the mark survives
-- later subscription webhooks; the next paid invoice clears it.
ALTER TABLE billing_subscriptions ADD COLUMN payment_reversed_at timestamptz;
