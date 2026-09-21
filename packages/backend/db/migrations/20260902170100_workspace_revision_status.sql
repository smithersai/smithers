ALTER TABLE workspaces
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'container'
        CHECK (kind IN ('container', 'vm', 'desktop')),
    ADD COLUMN environment_source TEXT NOT NULL DEFAULT '.smithers/environment.nix',
    ADD COLUMN environment_revision TEXT NOT NULL DEFAULT '',
    ADD COLUMN environment_closure_hash TEXT NOT NULL DEFAULT '',
    ADD COLUMN started_at TIMESTAMPTZ,
    ADD COLUMN resumed_at TIMESTAMPTZ,
    ADD COLUMN head_change_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN head_commit_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN ahead INTEGER NOT NULL DEFAULT 0 CHECK (ahead >= 0),
    ADD COLUMN behind INTEGER NOT NULL DEFAULT 0 CHECK (behind >= 0);

-- Existing running workspaces were necessarily started before this migration.
-- Their creation time is the least surprising lower bound for uptime.
UPDATE workspaces
SET started_at = created_at
WHERE status = 'running';
