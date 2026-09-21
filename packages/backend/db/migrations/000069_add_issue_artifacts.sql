-- Issue artifacts: research, plans, review logs attached to issues.
CREATE TABLE IF NOT EXISTS issue_artifacts (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    issue_id        BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    step_name       VARCHAR(255) NOT NULL DEFAULT '',
    size            BIGINT NOT NULL DEFAULT 0 CHECK (size >= 0),
    content_type    VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
    status          VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
    gcs_key         TEXT NOT NULL,
    confirmed_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (issue_id, name)
);

CREATE INDEX IF NOT EXISTS idx_issue_artifacts_repo_id ON issue_artifacts (repository_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issue_artifacts_issue_id ON issue_artifacts (issue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issue_artifacts_expires_at ON issue_artifacts (expires_at);
