-- Bind OAuth2 grants to the personal access token that authorized them.
--
-- A token-authenticated GET /api/oauth2/authorize mints a first-party grant
-- with a 90-day rolling refresh token that had no link to the presenting
-- PAT: deleting the PAT (or its 1 h sandbox-clone expiry) left the grant
-- alive. Every code, access token and refresh token now records its source
-- PAT and is deleted with it (ON DELETE CASCADE); the service also caps the
-- grant's lifetime at the PAT's expiry and refuses refresh once it is gone.
--
-- access_tokens.system_issued marks tokens minted by the platform for
-- sandboxes, workspaces and imports (never by a user); such tokens may not
-- authorize OAuth2 grants at all.
ALTER TABLE access_tokens
  ADD COLUMN IF NOT EXISTS system_issued BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE oauth2_authorization_codes
  ADD COLUMN IF NOT EXISTS source_access_token_id BIGINT REFERENCES access_tokens(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_oauth2_authorization_codes_source_access_token_id
  ON oauth2_authorization_codes (source_access_token_id);

ALTER TABLE oauth2_access_tokens
  ADD COLUMN IF NOT EXISTS source_access_token_id BIGINT REFERENCES access_tokens(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_oauth2_access_tokens_source_access_token_id
  ON oauth2_access_tokens (source_access_token_id);

ALTER TABLE oauth2_refresh_tokens
  ADD COLUMN IF NOT EXISTS source_access_token_id BIGINT REFERENCES access_tokens(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_oauth2_refresh_tokens_source_access_token_id
  ON oauth2_refresh_tokens (source_access_token_id);
