-- Pair session links (amendment A — configurable like Google Docs). Access via
-- an anyone-with-link slug is modeled as per-link ROWS rather than a single
-- session-level link_role, so the owner may mint TWO concurrent links for one
-- session (a view link and an edit link), each carrying its own role, revoked
-- and rotated independently. `/s/<slug>` resolves to the session at that link's
-- role; 'restricted' mode = no active (unrevoked) links. The slug is a
-- server-minted, unguessable base62 value and is NOT a bearer — every request
-- is still ACL-evaluated against the signed-in visitor, and joining a link
-- still requires AuthorizePairing to pass.
CREATE TABLE IF NOT EXISTS pair_session_links (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  TEXT NOT NULL REFERENCES pair_sessions(id) ON DELETE CASCADE,
    slug        TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    created_by  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Slugs are globally unique so /s/<slug> resolves unambiguously.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pair_session_links_slug
    ON pair_session_links (slug);

-- At most one live link per (session, role): one view link and one edit link
-- concurrently, no more. Revoking clears the slot so a fresh link can be minted.
CREATE UNIQUE INDEX IF NOT EXISTS pair_session_links_one_live_per_role
    ON pair_session_links (session_id, role)
    WHERE revoked_at IS NULL;
