-- Tickets 0115 + 0118: denormalize repository_id (and session_id for parts)
-- into agent_messages and agent_parts so the Electric proxy auth can enforce
-- per-repo + per-session shape subscriptions.
--
-- Why:
--   - Electric's where-clause proxy validates `repository_id IN (...)` scoping
--     on every shape (internal/electric/auth.go). Raw agent_messages /
--     agent_parts shapes are rejected today because the tables don't carry
--     repository_id.
--   - Per-session cardinality is what clients actually want: one shape per
--     open chat tab, LRU-evicted on close (see .smithers/specs/ios-and-remote-
--     sandboxes-production-shapes.md and .smithers/tickets/0115, 0118).
--   - Denormalizing session_id onto agent_parts avoids a join-per-event in
--     the Electric stream and lets the shape where-clause be purely local
--     to the exact table.
--
-- Behavior:
--   - Live rows get backfilled by walking the FK chain: agent_parts ->
--     agent_messages -> agent_sessions.repository_id.
--   - New INSERTs are required to populate the denorm fields (see the
--     updated INSERT queries in db/queries/agent.sql and the service-
--     layer call sites in internal/services/agent.go).
--   - Append-only semantics: no message-level or part-level tombstone in v1.
--     Parent session tombstone from ticket 0114 drives local cache purge on
--     subscribed clients (they observe agent_sessions.deleted_at IS NOT NULL
--     and drop their cached children).
--
-- Forward-only: atlas-managed, forward-only. atlas.sum is regenerated with
-- `atlas migrate hash` after this file lands.

------------------------------------------------------------------------------
-- Ticket 0115: agent_messages.repository_id
------------------------------------------------------------------------------

-- Step 1: add the column nullable so the backfill can run without a
-- not-null violation on existing rows.
ALTER TABLE agent_messages
    ADD COLUMN IF NOT EXISTS repository_id BIGINT;

-- Step 2: backfill from the parent session. Every agent_messages row has a
-- NOT NULL session_id referencing agent_sessions(id), so the JOIN is total.
UPDATE agent_messages m
SET repository_id = s.repository_id
FROM agent_sessions s
WHERE m.session_id = s.id
  AND m.repository_id IS NULL;

-- Step 3: lock the invariant in (NOT NULL + FK).
ALTER TABLE agent_messages
    ALTER COLUMN repository_id SET NOT NULL;

ALTER TABLE agent_messages
    ADD CONSTRAINT agent_messages_repository_id_fkey
    FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE;

-- Step 4: production-shape index. The Electric where-clause is
-- `repository_id IN (...) AND session_id IN (...)`, ordered by sequence on
-- the client side; `(repository_id, session_id, sequence)` matches directly.
CREATE INDEX IF NOT EXISTS idx_agent_messages_repo_session_sequence
    ON agent_messages (repository_id, session_id, sequence);

------------------------------------------------------------------------------
-- Ticket 0118: agent_parts.repository_id + session_id
------------------------------------------------------------------------------

-- Step 1: nullable columns for the backfill window.
ALTER TABLE agent_parts
    ADD COLUMN IF NOT EXISTS repository_id BIGINT,
    ADD COLUMN IF NOT EXISTS session_id    UUID;

-- Step 2: backfill by walking agent_parts -> agent_messages ->
-- agent_sessions. Every agent_parts row references agent_messages.id, and
-- every agent_messages row references a session; the two-hop JOIN is total.
UPDATE agent_parts p
SET
    repository_id = s.repository_id,
    session_id    = s.id
FROM agent_messages m
JOIN agent_sessions s ON s.id = m.session_id
WHERE p.message_id = m.id
  AND (p.repository_id IS NULL OR p.session_id IS NULL);

-- Step 3: lock invariants.
ALTER TABLE agent_parts
    ALTER COLUMN repository_id SET NOT NULL,
    ALTER COLUMN session_id    SET NOT NULL;

ALTER TABLE agent_parts
    ADD CONSTRAINT agent_parts_repository_id_fkey
    FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE;

ALTER TABLE agent_parts
    ADD CONSTRAINT agent_parts_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE;

-- Step 4: production-shape index matching the where-clause
-- `repository_id IN (...) AND session_id IN (...)` ordered by
-- (message_id, part_index) for transcript replay.
CREATE INDEX IF NOT EXISTS idx_agent_parts_repo_session_message_partindex
    ON agent_parts (repository_id, session_id, message_id, part_index);
