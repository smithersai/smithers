ALTER TABLE workflow_runs
ADD COLUMN IF NOT EXISTS jjhub_token_id BIGINT;
