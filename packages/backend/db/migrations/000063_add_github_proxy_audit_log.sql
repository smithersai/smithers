CREATE TABLE IF NOT EXISTS github_proxy_audit_log (
    id              BIGSERIAL PRIMARY KEY,
    workflow_run_id BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    method          VARCHAR(16) NOT NULL,
    path            TEXT NOT NULL,
    status_code     INTEGER NOT NULL,
    decision        VARCHAR(16) NOT NULL CHECK (decision IN ('allow', 'deny')),
    reason          TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_github_proxy_audit_log_workflow_run_created
    ON github_proxy_audit_log (workflow_run_id, created_at DESC);
