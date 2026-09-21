ALTER TABLE protected_bookmarks
    ADD COLUMN IF NOT EXISTS require_status_checks BOOLEAN NOT NULL DEFAULT FALSE;
