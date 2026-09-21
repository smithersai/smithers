-- Per-repository agent workspace environment configuration.
--
-- Environment variables are intentionally plaintext: they remain available to
-- the agent after setup. Setup secrets use the same application-layer
-- AES-256-GCM codec as repository/webhook credentials and are write-only over
-- the public API.

CREATE TABLE IF NOT EXISTS repository_agent_environments (
    repository_id        BIGINT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    setup_script         TEXT NOT NULL DEFAULT '',
    environment_variables JSONB NOT NULL DEFAULT '[]'::jsonb
                          CHECK (jsonb_typeof(environment_variables) = 'array'),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS repository_agent_environment_secrets (
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    value_encrypted BYTEA NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (repository_id, name)
);

ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS provisioning_stage TEXT NOT NULL DEFAULT '';
