CREATE TABLE IF NOT EXISTS github_app_installations (
    installation_id       BIGINT PRIMARY KEY,
    account_login         VARCHAR(255) NOT NULL DEFAULT '',
    account_type          VARCHAR(64) NOT NULL DEFAULT '',
    repository_selection  VARCHAR(32) NOT NULL DEFAULT '',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS github_app_installation_repositories (
    installation_id       BIGINT NOT NULL REFERENCES github_app_installations(installation_id) ON DELETE CASCADE,
    github_repository_id  BIGINT NOT NULL,
    owner_login           VARCHAR(255) NOT NULL DEFAULT '',
    owner_login_lower     VARCHAR(255) NOT NULL DEFAULT '',
    repo_name             VARCHAR(255) NOT NULL DEFAULT '',
    repo_name_lower       VARCHAR(255) NOT NULL DEFAULT '',
    is_private            BOOLEAN NOT NULL DEFAULT FALSE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (installation_id, github_repository_id)
);

CREATE INDEX IF NOT EXISTS idx_github_app_installation_repos_owner_repo
    ON github_app_installation_repositories (owner_login_lower, repo_name_lower);
CREATE INDEX IF NOT EXISTS idx_github_app_installation_repos_installation
    ON github_app_installation_repositories (installation_id);

CREATE TABLE IF NOT EXISTS github_webhook_jobs (
    id                    BIGSERIAL PRIMARY KEY,
    delivery_id           UUID NOT NULL UNIQUE,
    event_type            VARCHAR(64) NOT NULL,
    action                VARCHAR(64) NOT NULL DEFAULT '',
    installation_id       BIGINT,
    github_repository_id  BIGINT,
    payload               JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    status                VARCHAR(16) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    attempts              INTEGER NOT NULL DEFAULT 0,
    error                 TEXT NOT NULL DEFAULT '',
    available_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at          TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_github_webhook_jobs_pending_dequeue
    ON github_webhook_jobs (available_at, id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_github_webhook_jobs_installation
    ON github_webhook_jobs (installation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_github_webhook_jobs_repository
    ON github_webhook_jobs (github_repository_id, created_at DESC);
