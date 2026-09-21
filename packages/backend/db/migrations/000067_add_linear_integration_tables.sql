-- Linear integration: per-user Linear connection mapped to a Smithers repo.
CREATE TABLE IF NOT EXISTS linear_integrations (
    id                       BIGSERIAL PRIMARY KEY,
    user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id                   BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
    linear_team_id           VARCHAR(255) NOT NULL,
    linear_team_name         VARCHAR(255) NOT NULL DEFAULT '',
    linear_team_key          VARCHAR(32) NOT NULL DEFAULT '',
    access_token_encrypted   BYTEA NOT NULL,
    refresh_token_encrypted  BYTEA,
    token_expires_at         TIMESTAMPTZ,
    webhook_secret           VARCHAR(255) NOT NULL,
    jjhub_repo_id            BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    jjhub_repo_owner         VARCHAR(255) NOT NULL,
    jjhub_repo_name          VARCHAR(255) NOT NULL,
    linear_actor_id          VARCHAR(255) NOT NULL DEFAULT '',
    is_active                BOOLEAN NOT NULL DEFAULT TRUE,
    last_sync_at             TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, linear_team_id, jjhub_repo_id)
);

CREATE INDEX IF NOT EXISTS idx_linear_integrations_user_id ON linear_integrations (user_id);
CREATE INDEX IF NOT EXISTS idx_linear_integrations_repo_id ON linear_integrations (jjhub_repo_id);
CREATE INDEX IF NOT EXISTS idx_linear_integrations_team_id ON linear_integrations (linear_team_id);
CREATE INDEX IF NOT EXISTS idx_linear_integrations_active ON linear_integrations (is_active) WHERE is_active = TRUE;

-- Linear issue mapping: Smithers issue ↔ Linear issue.
CREATE TABLE IF NOT EXISTS linear_issue_map (
    id                  BIGSERIAL PRIMARY KEY,
    integration_id      BIGINT NOT NULL REFERENCES linear_integrations(id) ON DELETE CASCADE,
    jjhub_issue_id      BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    jjhub_issue_number  BIGINT NOT NULL,
    linear_issue_id     VARCHAR(255) NOT NULL,
    linear_identifier   VARCHAR(64) NOT NULL DEFAULT '',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (integration_id, jjhub_issue_id),
    UNIQUE (integration_id, linear_issue_id)
);

CREATE INDEX IF NOT EXISTS idx_linear_issue_map_integration ON linear_issue_map (integration_id);
CREATE INDEX IF NOT EXISTS idx_linear_issue_map_jjhub_issue ON linear_issue_map (jjhub_issue_id);
CREATE INDEX IF NOT EXISTS idx_linear_issue_map_linear_issue ON linear_issue_map (linear_issue_id);

-- Linear comment mapping: Smithers comment ↔ Linear comment.
CREATE TABLE IF NOT EXISTS linear_comment_map (
    id                  BIGSERIAL PRIMARY KEY,
    issue_map_id        BIGINT NOT NULL REFERENCES linear_issue_map(id) ON DELETE CASCADE,
    jjhub_comment_id    BIGINT NOT NULL,
    linear_comment_id   VARCHAR(255) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (issue_map_id, jjhub_comment_id),
    UNIQUE (issue_map_id, linear_comment_id)
);

CREATE INDEX IF NOT EXISTS idx_linear_comment_map_issue_map ON linear_comment_map (issue_map_id);

-- Linear sync operations: audit log and loop-guard temporal dedup.
CREATE TABLE IF NOT EXISTS linear_sync_ops (
    id              BIGSERIAL PRIMARY KEY,
    integration_id  BIGINT NOT NULL REFERENCES linear_integrations(id) ON DELETE CASCADE,
    source          VARCHAR(16) NOT NULL CHECK (source IN ('jjhub', 'linear')),
    target          VARCHAR(16) NOT NULL CHECK (target IN ('jjhub', 'linear')),
    entity          VARCHAR(32) NOT NULL CHECK (entity IN ('issue', 'comment')),
    entity_id       VARCHAR(255) NOT NULL,
    action          VARCHAR(32) NOT NULL CHECK (action IN ('create', 'update', 'delete', 'close', 'reopen', 'initial_sync')),
    status          VARCHAR(16) NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failed', 'skipped')),
    error_message   TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_linear_sync_ops_integration ON linear_sync_ops (integration_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_linear_sync_ops_dedup ON linear_sync_ops (integration_id, entity, entity_id, created_at DESC);
