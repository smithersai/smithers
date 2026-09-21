ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS target_bookmark TEXT NOT NULL DEFAULT 'main';
