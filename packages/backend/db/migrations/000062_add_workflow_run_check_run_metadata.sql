ALTER TABLE workflow_runs
    ADD COLUMN IF NOT EXISTS check_run_id BIGINT,
    ADD COLUMN IF NOT EXISTS check_run_url TEXT;
