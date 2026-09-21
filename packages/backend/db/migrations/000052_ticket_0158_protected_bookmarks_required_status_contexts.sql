ALTER TABLE protected_bookmarks
    ADD COLUMN IF NOT EXISTS required_status_contexts TEXT[] NOT NULL DEFAULT '{}'::text[];
