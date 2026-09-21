-- Add OAuth2 tables
CREATE TABLE IF NOT EXISTS oauth2_applications (
    id                  BIGSERIAL PRIMARY KEY,
    owner_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    client_id           VARCHAR(255) NOT NULL UNIQUE,
    client_secret_hash  VARCHAR(255) NOT NULL,
    redirect_uris       TEXT[] NOT NULL,
    scopes              TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    confidential        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_oauth2_applications_client_id ON oauth2_applications (client_id);
CREATE INDEX idx_oauth2_applications_owner_id ON oauth2_applications (owner_id);

-- OAuth2 authorization codes
CREATE TABLE IF NOT EXISTS oauth2_authorization_codes (
    code              VARCHAR(255) PRIMARY KEY,
    app_id            BIGINT NOT NULL REFERENCES oauth2_applications(id) ON DELETE CASCADE,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri      VARCHAR(2048) NOT NULL,
    scopes            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    code_challenge    VARCHAR(255),
    code_challenge_method VARCHAR(8) CHECK (code_challenge_method IN ('S256', 'plain')),
    expires_at        TIMESTAMPTZ NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_oauth2_authorization_codes_app_id ON oauth2_authorization_codes (app_id);
CREATE INDEX idx_oauth2_authorization_codes_expires_at ON oauth2_authorization_codes (expires_at);

-- OAuth2 access tokens
CREATE TABLE IF NOT EXISTS oauth2_access_tokens (
    id            BIGSERIAL PRIMARY KEY,
    token_hash    VARCHAR(255) NOT NULL UNIQUE,
    app_id        BIGINT NOT NULL REFERENCES oauth2_applications(id) ON DELETE CASCADE,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_oauth2_access_tokens_token_hash ON oauth2_access_tokens (token_hash);
CREATE INDEX idx_oauth2_access_tokens_app_id ON oauth2_access_tokens (app_id);
CREATE INDEX idx_oauth2_access_tokens_user_id ON oauth2_access_tokens (user_id);
CREATE INDEX idx_oauth2_access_tokens_expires_at ON oauth2_access_tokens (expires_at);

-- OAuth2 refresh tokens
CREATE TABLE IF NOT EXISTS oauth2_refresh_tokens (
    id            BIGSERIAL PRIMARY KEY,
    token_hash    VARCHAR(255) NOT NULL UNIQUE,
    app_id        BIGINT NOT NULL REFERENCES oauth2_applications(id) ON DELETE CASCADE,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_oauth2_refresh_tokens_token_hash ON oauth2_refresh_tokens (token_hash);
CREATE INDEX idx_oauth2_refresh_tokens_app_id ON oauth2_refresh_tokens (app_id);
CREATE INDEX idx_oauth2_refresh_tokens_user_id ON oauth2_refresh_tokens (user_id);
CREATE INDEX idx_oauth2_refresh_tokens_expires_at ON oauth2_refresh_tokens (expires_at);