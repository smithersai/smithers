CREATE TABLE IF NOT EXISTS workflow_run_logs (
    -- Reuse workflow_logs_id_seq so SSE event IDs remain monotonic across
    -- legacy workflow_logs rows and run-scoped workflow_run_logs rows.
    id               BIGINT PRIMARY KEY DEFAULT nextval('workflow_logs_id_seq'),
    workflow_run_id  BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    workflow_step_id BIGINT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
    sequence         BIGINT NOT NULL,
    stream           VARCHAR(16) NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system')),
    entry            TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workflow_run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_logs_run_id
    ON workflow_run_logs (workflow_run_id, id);
