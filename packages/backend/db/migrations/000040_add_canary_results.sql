CREATE TABLE IF NOT EXISTS canary_results (
    id                BIGSERIAL PRIMARY KEY,
    suite             VARCHAR(32) NOT NULL,
    test_name         VARCHAR(128) NOT NULL,
    status            VARCHAR(16) NOT NULL CHECK (status IN ('success', 'failure')),
    duration_seconds  DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
    error_message     TEXT NOT NULL DEFAULT '',
    run_id            VARCHAR(128) NOT NULL DEFAULT '',
    reported_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (suite, test_name)
);

CREATE INDEX IF NOT EXISTS idx_canary_results_suite_reported
    ON canary_results (suite, reported_at DESC);
