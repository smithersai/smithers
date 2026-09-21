ALTER TABLE access_tokens
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_access_tokens_expires_at
    ON access_tokens (expires_at);
