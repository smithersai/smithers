-- Bring-your-own subscriptions: a user or organization connects a Claude or
-- Codex account once; the control plane keeps the refresh token at rest, mints
-- short-lived access tokens, and the per-sandbox egress proxy injects them on
-- the provider host and header. The guest only ever sees placeholders.
-- RFD-003 (docs/rfds/003-bring-your-own-subscriptions.md).
-- smithers:migration-contract-reviewed
CREATE TABLE IF NOT EXISTS provider_connections (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_type              VARCHAR(16) NOT NULL CHECK (owner_type IN ('user', 'org')),
    user_id                 BIGINT REFERENCES users(id) ON DELETE CASCADE,
    org_id                  BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
    provider                VARCHAR(16) NOT NULL CHECK (provider IN ('claude', 'codex')),
    kind                    VARCHAR(16) NOT NULL CHECK (kind IN ('setup_token', 'oauth')),
    label                   VARCHAR(80) NOT NULL DEFAULT '',
    account_email           VARCHAR(255) NOT NULL DEFAULT '',
    account_id              VARCHAR(255) NOT NULL DEFAULT '',
    plan                    VARCHAR(64) NOT NULL DEFAULT '',
    access_token_encrypted  BYTEA NOT NULL,
    refresh_token_encrypted BYTEA,
    access_expires_at       TIMESTAMPTZ,
    state                   VARCHAR(16) NOT NULL DEFAULT 'active'
                            CHECK (state IN ('active', 'refresh_failed', 'revoked')),
    last_refresh_at         TIMESTAMPTZ,
    next_refresh_at         TIMESTAMPTZ,
    refresh_failures        INTEGER NOT NULL DEFAULT 0,
    last_error              TEXT NOT NULL DEFAULT '',
    created_by              BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (owner_type = 'user' AND user_id IS NOT NULL AND org_id IS NULL)
        OR (owner_type = 'org' AND org_id IS NOT NULL AND user_id IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_provider_connections_user_provider
    ON provider_connections (user_id, provider, updated_at DESC) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_provider_connections_org_provider
    ON provider_connections (org_id, provider, updated_at DESC) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_provider_connections_refresh_due
    ON provider_connections (next_refresh_at) WHERE state = 'active' AND refresh_token_encrypted IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_connection_grants (
    id               BIGSERIAL PRIMARY KEY,
    connection_id    UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
    repository_id    BIGINT REFERENCES repositories(id) ON DELETE CASCADE,
    org_id           BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
    all_repositories BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (all_repositories OR repository_id IS NOT NULL OR org_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_provider_connection_grants_connection
    ON provider_connection_grants (connection_id);

-- Which connection an agent run prefers for a repository. Adding a NOT NULL
-- column with a constant DEFAULT is metadata-only on PostgreSQL 11+.
ALTER TABLE repository_agent_environments
    ADD COLUMN IF NOT EXISTS provider_connection_preference VARCHAR(16) NOT NULL DEFAULT 'org_first';
ALTER TABLE repository_agent_environments
    DROP CONSTRAINT IF EXISTS repository_agent_environments_provider_connection_preference_check;
ALTER TABLE repository_agent_environments
    ADD CONSTRAINT repository_agent_environments_provider_connection_preference_check
    CHECK (provider_connection_preference IN ('org_first', 'user_first', 'org_only', 'user_only', 'platform_only'));
