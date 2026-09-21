-- Pair session members: row-per-participant (decision #4's members+presence
-- shape). Presence (cursor/caret/focus) rides this member's own row so an 80ms
-- caret beat re-ships one row, never the whole room, never the draft or meta
-- rows. `removed_at` is a soft-revoke: the owner deletes access by stamping it,
-- and the revoked client's next REST/shape request fails closed.
CREATE TABLE IF NOT EXISTS pair_session_members (
    session_id            TEXT NOT NULL REFERENCES pair_sessions(id) ON DELETE CASCADE,
    user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role                  TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
    invited_via_invite_id UUID,
    presence              JSONB NOT NULL DEFAULT '{}'::jsonb,
    presence_updated_at   TIMESTAMPTZ,
    last_seen_at          TIMESTAMPTZ,
    joined_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_at            TIMESTAMPTZ,
    PRIMARY KEY (session_id, user_id)
);

-- Exactly one live owner per session (the creator).
CREATE UNIQUE INDEX IF NOT EXISTS pair_session_one_owner
    ON pair_session_members (session_id)
    WHERE role = 'owner' AND removed_at IS NULL;

-- Fast lookup of live members for a session (membership ACL + shape auth).
CREATE INDEX IF NOT EXISTS pair_session_members_session_live
    ON pair_session_members (session_id)
    WHERE removed_at IS NULL;
