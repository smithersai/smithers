-- Credit ledger: append-only log of all credit transactions.
-- Positive amount_cents = credit added; negative = credit consumed.
CREATE TABLE IF NOT EXISTS billing_credit_ledger (
    id                  BIGSERIAL PRIMARY KEY,
    billing_account_id  BIGINT NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
    amount_cents        BIGINT NOT NULL,
    balance_after_cents BIGINT NOT NULL,
    reason              VARCHAR(255) NOT NULL DEFAULT '',
    category            VARCHAR(32) NOT NULL CHECK (category IN (
                            'monthly_grant', 'purchase', 'deduction', 'refund', 'gift', 'expiration', 'adjustment'
                        )),
    metric_key          VARCHAR(64) NOT NULL DEFAULT '',
    idempotency_key     VARCHAR(255) NOT NULL DEFAULT '',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_credit_ledger_account
    ON billing_credit_ledger (billing_account_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_credit_ledger_idempotency
    ON billing_credit_ledger (billing_account_id, idempotency_key)
    WHERE idempotency_key != '';

-- Materialized credit balance per account (updated via ledger inserts).
CREATE TABLE IF NOT EXISTS billing_credit_balances (
    billing_account_id  BIGINT PRIMARY KEY REFERENCES billing_accounts(id) ON DELETE CASCADE,
    balance_cents       BIGINT NOT NULL DEFAULT 0,
    last_grant_at       TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
