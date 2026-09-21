ALTER TABLE import_jobs
    ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS target_bookmark TEXT NOT NULL DEFAULT 'main';

CREATE INDEX IF NOT EXISTS idx_import_jobs_workspace_id
    ON import_jobs (workspace_id)
    WHERE workspace_id IS NOT NULL;
