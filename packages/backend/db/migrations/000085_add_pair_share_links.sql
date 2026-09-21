-- Smithers Pair: per-room shareable access links.
--
-- A jjhub user mints a link bound to one room at a chosen access level. The
-- 'view' level can read the room (REST reads + the Electric pair_state shape)
-- but must not drive the shared Codex agent; the 'edit' level can additionally
-- mutate the room. The raw token is never stored — only its sha256 hex, exactly
-- like access_tokens.token_hash. Reads/writes are gated in the pair routes and
-- the Electric auth middleware via pairauth.AuthorizeRoom.

CREATE TABLE IF NOT EXISTS pair_share_links (
    id           BIGSERIAL PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,
    room_id      TEXT NOT NULL,
    level        VARCHAR(8) NOT NULL DEFAULT 'view' CHECK (level IN ('view','edit')),
    created_by   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at   TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pair_share_links_room ON pair_share_links (room_id);
