ALTER TABLE billing_subscriptions
    ADD COLUMN past_due_since TIMESTAMPTZ;

-- Existing projections cannot recover the original transition timestamp.
-- updated_at is the safest available anchor and, unlike current_period_end,
-- never grants an entire newly-unpaid billing period plus the grace window.
UPDATE billing_subscriptions
SET past_due_since = updated_at
WHERE status = 'past_due';
