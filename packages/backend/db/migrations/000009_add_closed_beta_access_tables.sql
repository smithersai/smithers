CREATE TABLE IF NOT EXISTS beta_whitelist_entries (
    id                   BIGSERIAL PRIMARY KEY,
    identity_type        VARCHAR(16) NOT NULL CHECK (identity_type IN ('email', 'wallet', 'username')),
    identity_value       VARCHAR(255) NOT NULL,
    lower_identity_value VARCHAR(255) NOT NULL,
    created_by           BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (identity_type, lower_identity_value)
);

CREATE INDEX IF NOT EXISTS idx_beta_whitelist_created_by ON beta_whitelist_entries (created_by);

CREATE TABLE IF NOT EXISTS beta_waitlist_entries (
    id          BIGSERIAL PRIMARY KEY,
    email       VARCHAR(255) NOT NULL,
    lower_email VARCHAR(255) NOT NULL UNIQUE,
    note        TEXT NOT NULL DEFAULT '',
    status      VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    source      VARCHAR(32) NOT NULL DEFAULT 'unknown',
    approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_beta_waitlist_status_created ON beta_waitlist_entries (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_beta_waitlist_approved_by ON beta_waitlist_entries (approved_by);
