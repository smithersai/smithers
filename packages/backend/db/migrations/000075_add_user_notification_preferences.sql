-- Per-user notification preferences for in-app notification categories.
-- Missing row means defaults apply, so all preference flags default to true.
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id              BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    notify_issues        BOOLEAN NOT NULL DEFAULT TRUE,
    notify_landings      BOOLEAN NOT NULL DEFAULT TRUE,
    notify_mentions      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
