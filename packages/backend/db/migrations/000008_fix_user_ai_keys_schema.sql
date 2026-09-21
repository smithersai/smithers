-- Align user_ai_keys table shape with generated sqlc models and queries.
ALTER TABLE user_ai_keys
    ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_user_ai_keys_expires_at ON user_ai_keys(expires_at);
