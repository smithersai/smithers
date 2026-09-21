CREATE TABLE IF NOT EXISTS stripe_processed_events (
    event_id     VARCHAR(255) PRIMARY KEY,
    event_type   VARCHAR(255) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_processed_events_processed_at
    ON stripe_processed_events (processed_at DESC);
