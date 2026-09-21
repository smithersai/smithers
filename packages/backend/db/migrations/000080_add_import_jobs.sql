CREATE TABLE IF NOT EXISTS import_jobs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id    BIGINT REFERENCES repositories(id) ON DELETE SET NULL,
    github_owner     VARCHAR(255) NOT NULL,
    github_repo      VARCHAR(255) NOT NULL,
    repo_owner       VARCHAR(255) NOT NULL DEFAULT '',
    repo_name        VARCHAR(255) NOT NULL DEFAULT '',
    branch           VARCHAR(255) NOT NULL DEFAULT '',
    status           VARCHAR(16) NOT NULL DEFAULT 'cloning'
                     CHECK (status IN ('cloning', 'ready', 'failed')),
    error            TEXT NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_user_created
    ON import_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_jobs_status
    ON import_jobs (status, created_at DESC);
