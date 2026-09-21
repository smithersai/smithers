CREATE TABLE IF NOT EXISTS billing_accounts (
    id                    BIGSERIAL PRIMARY KEY,
    owner_type            VARCHAR(16) NOT NULL CHECK (owner_type IN ('user', 'org')),
    owner_id              BIGINT NOT NULL,
    stripe_customer_id    VARCHAR(255) NOT NULL UNIQUE,
    stripe_customer_email VARCHAR(255) NOT NULL DEFAULT '',
    stripe_customer_name  VARCHAR(255) NOT NULL DEFAULT '',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (owner_type, owner_id)
);

CREATE INDEX idx_billing_accounts_owner
    ON billing_accounts (owner_type, owner_id);

CREATE TABLE IF NOT EXISTS billing_subscriptions (
    id                    BIGSERIAL PRIMARY KEY,
    billing_account_id    BIGINT NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
    stripe_subscription_id VARCHAR(255) NOT NULL UNIQUE,
    stripe_price_id       VARCHAR(255) NOT NULL DEFAULT '',
    plan_key              VARCHAR(64) NOT NULL DEFAULT '',
    billing_interval      VARCHAR(16) NOT NULL DEFAULT '' CHECK (billing_interval IN ('', 'monthly', 'annual')),
    status                VARCHAR(32) NOT NULL,
    quantity              BIGINT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    trial_end             TIMESTAMPTZ,
    current_period_start  TIMESTAMPTZ,
    current_period_end    TIMESTAMPTZ,
    cancel_at_period_end  BOOLEAN NOT NULL DEFAULT FALSE,
    canceled_at           TIMESTAMPTZ,
    raw_payload           JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(raw_payload) = 'object'),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_billing_subscriptions_account_updated
    ON billing_subscriptions (billing_account_id, updated_at DESC);

CREATE INDEX idx_billing_subscriptions_account_status
    ON billing_subscriptions (billing_account_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS billing_entitlements (
    id                 BIGSERIAL PRIMARY KEY,
    billing_account_id BIGINT NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
    feature_key        VARCHAR(255) NOT NULL,
    active             BOOLEAN NOT NULL DEFAULT TRUE,
    last_synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (billing_account_id, feature_key)
);

CREATE INDEX idx_billing_entitlements_account_active
    ON billing_entitlements (billing_account_id, active);

CREATE TABLE IF NOT EXISTS billing_usage_counters (
    id                          BIGSERIAL PRIMARY KEY,
    owner_type                  VARCHAR(16) NOT NULL CHECK (owner_type IN ('user', 'org')),
    owner_id                    BIGINT NOT NULL,
    metric_key                  VARCHAR(64) NOT NULL,
    period_start                TIMESTAMPTZ NOT NULL,
    period_end                  TIMESTAMPTZ NOT NULL,
    included_quantity           BIGINT NOT NULL DEFAULT 0 CHECK (included_quantity >= 0),
    consumed_quantity           BIGINT NOT NULL DEFAULT 0 CHECK (consumed_quantity >= 0),
    overage_quantity            BIGINT NOT NULL DEFAULT 0 CHECK (overage_quantity >= 0),
    last_reported_meter_event_id VARCHAR(255) NOT NULL DEFAULT '',
    last_synced_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (period_end > period_start),
    UNIQUE (owner_type, owner_id, metric_key, period_start, period_end)
);

CREATE INDEX idx_billing_usage_counters_owner_metric_period
    ON billing_usage_counters (owner_type, owner_id, metric_key, period_start DESC);
