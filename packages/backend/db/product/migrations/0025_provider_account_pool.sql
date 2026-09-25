-- Provider account pool: many connections per provider, used round-robin by
-- the model proxy. last_used_at orders the rotation (least recently used
-- first, sort_order breaking ties), limited_until parks an account that hit a
-- usage limit until it resets, and api_key connections carry an Anthropic
-- API key instead of a subscription token.
ALTER TABLE provider_connections
    ADD COLUMN limited_until timestamptz,
    ADD COLUMN last_used_at timestamptz,
    ADD COLUMN sort_order integer NOT NULL DEFAULT 0;

ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_kind_check;
ALTER TABLE provider_connections ADD CONSTRAINT provider_connections_kind_check
    CHECK (kind IN ('setup_token', 'oauth', 'api_key'));

-- A browser-driven OpenAI device-code sign-in. The device authorization id is
-- a bearer secret for the pending sign-in, so it is stored encrypted. One
-- poller at a time holds poll_lease_until; a poll never runs before
-- next_poll_at, the interval OpenAI asked for.
CREATE TABLE provider_connection_device_logins (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider                  varchar(16) NOT NULL CHECK (provider IN ('codex')),
    device_auth_id_encrypted  bytea NOT NULL,
    user_code                 varchar(32) NOT NULL,
    interval_seconds          integer NOT NULL DEFAULT 5,
    expires_at                timestamptz NOT NULL,
    next_poll_at              timestamptz NOT NULL DEFAULT NOW(),
    poll_lease_until          timestamptz,
    state                     varchar(16) NOT NULL DEFAULT 'pending'
                              CHECK (state IN ('pending', 'connected', 'expired', 'failed')),
    connection_id             uuid REFERENCES provider_connections(id) ON DELETE SET NULL,
    last_error                text NOT NULL DEFAULT '',
    created_at                timestamptz NOT NULL DEFAULT NOW(),
    updated_at                timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_provider_connection_device_logins_user
    ON provider_connection_device_logins (user_id, created_at DESC);
