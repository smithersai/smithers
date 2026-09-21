ALTER TABLE oauth2_authorization_codes
    ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
