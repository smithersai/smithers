ALTER TABLE repositories
    ADD COLUMN IF NOT EXISTS mirror_destination TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS workspace_idle_timeout_secs INTEGER NOT NULL DEFAULT 1800 CHECK (workspace_idle_timeout_secs > 0),
    ADD COLUMN IF NOT EXISTS workspace_persistence VARCHAR(16) NOT NULL DEFAULT 'persistent'
        CHECK (workspace_persistence IN ('persistent', 'ephemeral')),
    ADD COLUMN IF NOT EXISTS workspace_dependencies TEXT[] NOT NULL DEFAULT '{}'::text[],
    ADD COLUMN IF NOT EXISTS landing_queue_mode VARCHAR(16) NOT NULL DEFAULT 'serialized'
        CHECK (landing_queue_mode IN ('serialized', 'parallel')),
    ADD COLUMN IF NOT EXISTS landing_queue_required_checks TEXT[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE protected_bookmarks
    ADD COLUMN IF NOT EXISTS required_checks TEXT[] NOT NULL DEFAULT '{}'::text[],
    ADD COLUMN IF NOT EXISTS dismiss_stale_reviews BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS restrict_push_teams TEXT[] NOT NULL DEFAULT '{}'::text[];
