-- Ticket 0136: last-accessed tracking for workspaces.
--
-- Adds workspaces.last_accessed_at TIMESTAMPTZ (nullable) to carry an
-- explicit "user intentionally opened this workspace most recently" signal,
-- distinct from last_activity_at which drives suspend/idle policy.
--
-- Why nullable (vs NOT NULL DEFAULT NOW()):
--   * Lets the switcher ordering fall through via COALESCE to
--     last_activity_at / created_at for rows that have never been
--     attached-to under the new code path.
--   * Avoids overwriting the historical record for rows that existed
--     pre-0136 — they remain "unknown last-access" until a real attach.
--
-- Backfill: existing rows get seeded from last_activity_at so that
-- immediately after the migration the switcher's relative ordering is
-- preserved. This is an approximation (last_activity_at ~= last attach),
-- not perfect historical truth, and that is acceptable as a one-time
-- migration tradeoff per ticket 0136.
--
-- Index shape: the 0135 listing query orders by
--   COALESCE(last_accessed_at, last_activity_at, created_at) DESC
-- filtered by user_id. A composite index (user_id, last_accessed_at
-- DESC NULLS LAST, last_activity_at DESC) lets Postgres walk rows per
-- user in the switcher's preferred order without hitting other rows;
-- the NULLS LAST keeps freshly-seeded rows ahead of never-accessed
-- ones. The partial predicate deleted_at IS NULL keeps the index
-- tight — tombstoned rows never appear in the switcher and so don't
-- need to be in this index.

ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;

-- One-time backfill: seed last_accessed_at from last_activity_at for
-- existing rows. Future inserts leave the column NULL until the first
-- real attach via TouchWorkspaceLastAccessed.
UPDATE workspaces
SET last_accessed_at = last_activity_at
WHERE last_accessed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspaces_user_recency
    ON workspaces (user_id, last_accessed_at DESC NULLS LAST, last_activity_at DESC)
    WHERE deleted_at IS NULL;
