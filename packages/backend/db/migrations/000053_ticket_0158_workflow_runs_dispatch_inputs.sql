ALTER TABLE workflow_runs
    ADD COLUMN IF NOT EXISTS dispatch_inputs JSONB;
