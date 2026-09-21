-- APNS/FCM device registrations for authenticated users.
--
-- MVP push notifications only send APNS stubs, but the platform column is
-- intentionally future-proofed for Android device tokens.

CREATE TABLE IF NOT EXISTS user_devices (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    apns_token    TEXT NOT NULL,
    platform      TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, apns_token)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user_platform
    ON user_devices (user_id, platform, last_seen_at DESC);
