-- Ticket 0114: add soft-delete tombstone to agent_sessions.
--
-- Why:
--   - The client's Electric shape for agent_sessions needs a visible->hidden
--     transition so subscribed clients purge the local cached row when a
--     session is deleted.
--   - A hard DELETE fan-out through Electric is not reliable for our bounded
--     local SQLite cache model (see .smithers/specs/ios-and-remote-sandboxes-production-shapes.md).
--
-- Behavior:
--   - NULL  => live row, visible to public API and to the Electric shape.
--   - !NULL => tombstoned row, hidden from both public API read paths and the
--             Electric shape (because the shape's where-clause filters
--             deleted_at IS NULL).
--
-- Forward-only: plue's db/migrations/ is atlas-managed, forward-only. The
-- atlas.sum file must be regenerated with `atlas migrate hash` after this
-- file lands (see scripts/migrate.sh).

ALTER TABLE agent_sessions
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial index on live rows for the common list-active-sessions-by-repo path.
-- Mirrors the db/schema.sql definition.
CREATE INDEX IF NOT EXISTS idx_agent_sessions_live_by_repo
    ON agent_sessions (repository_id, created_at DESC)
    WHERE deleted_at IS NULL;
