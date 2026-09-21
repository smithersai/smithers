-- Add landing_tasks table for the landing queue worker.
-- Uses FOR UPDATE SKIP LOCKED pattern for task queue (no external queue needed).

CREATE TABLE IF NOT EXISTS landing_tasks (
    id                 BIGSERIAL PRIMARY KEY,
    landing_request_id BIGINT NOT NULL REFERENCES landing_requests(id) ON DELETE CASCADE,
    repository_id      BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    status             VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
    priority           SMALLINT NOT NULL DEFAULT 1 CHECK (priority BETWEEN 0 AND 3),
    attempt            INTEGER NOT NULL DEFAULT 0,
    last_error         TEXT,
    available_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at         TIMESTAMPTZ,
    finished_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (landing_request_id)
);

CREATE INDEX IF NOT EXISTS idx_landing_tasks_status_priority ON landing_tasks (status, priority DESC, created_at ASC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_landing_tasks_repo_running ON landing_tasks (repository_id) WHERE status = 'running';
