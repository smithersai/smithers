-- Pair session invites (layer 2). Reuses the pairauth.TokenHash sha256 + TTL
-- plumbing from pair_share_links — the mint/hash/expiry plumbing survives, the
-- bearer-access model does not. Acceptance (or a matching lower_email sign-in
-- when no email transport is configured) upserts a pair_session_members row AND
-- auto-inserts an alpha_whitelist_entries row so a brand-new invitee can
-- complete invite -> sign up -> trial -> join (decision #6, the growth loop).
CREATE TABLE IF NOT EXISTS pair_session_invites (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id          TEXT NOT NULL REFERENCES pair_sessions(id) ON DELETE CASCADE,
    lower_email         TEXT NOT NULL,
    role                TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    token_hash          TEXT NOT NULL,
    invited_by          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at          TIMESTAMPTZ NOT NULL,
    accepted_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    accepted_at         TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Resolve a signed-in visitor's email against live invites for a session.
CREATE INDEX IF NOT EXISTS pair_session_invites_session_email
    ON pair_session_invites (session_id, lower_email)
    WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pair_session_invites_token_hash
    ON pair_session_invites (token_hash);
