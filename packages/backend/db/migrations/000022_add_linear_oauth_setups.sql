CREATE TABLE IF NOT EXISTS linear_oauth_setups (
    setup_key         VARCHAR(64) PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payload_encrypted BYTEA NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at        TIMESTAMPTZ NOT NULL,
    used_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_linear_oauth_setups_user_id ON linear_oauth_setups (user_id);
CREATE INDEX IF NOT EXISTS idx_linear_oauth_setups_expires_at ON linear_oauth_setups (expires_at);
