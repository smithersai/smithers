ALTER TABLE oauth2_refresh_tokens
ADD COLUMN IF NOT EXISTS scopes TEXT[];
