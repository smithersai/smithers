-- Smithers Pair sessions: one row per server-authoritative pairing session.
--
-- Replaces the monolithic pair_state jsonb room as the session-of-record.
-- `id` is a server-minted, unguessable base62 slug (>=128 bits of crypto/rand
-- entropy). It is the `/s/<id>` path segment and is NOT a bearer token —
-- possession grants nothing; every REST and Electric shape request is ACL-
-- evaluated server-side against the signed-in visitor.
--
-- Starting a session forks the owner's workspace (resume-then-fork, or
-- provision-on-empty) and the fork transparently replaces their sandbox
-- (decision #2). `source_workspace_id` is the owner's original workspace;
-- `workspace_id` is the fork bound to the session, NULL until the fork lands.
-- Modeled on 000086_add_repo_gateways (status lifecycle + partial-unique live
-- index).
CREATE TABLE IF NOT EXISTS pair_sessions (
    id                  TEXT PRIMARY KEY,
    owner_user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    workspace_id        UUID REFERENCES workspaces(id) ON DELETE SET NULL,
    access_mode         TEXT NOT NULL DEFAULT 'restricted'
                        CHECK (access_mode IN ('restricted', 'link')),
    status              TEXT NOT NULL DEFAULT 'provisioning'
                        CHECK (status IN ('provisioning', 'active', 'ended', 'failed')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at            TIMESTAMPTZ
);

-- At most one live (non-terminal) session per source workspace. 'failed' is
-- excluded alongside 'ended' so a dead fork never wedges the owner out of
-- starting a new session; a provisioning-timeout compensation sweep flips
-- stuck 'provisioning' rows to 'failed'.
CREATE UNIQUE INDEX IF NOT EXISTS pair_sessions_live_per_source
    ON pair_sessions (source_workspace_id)
    WHERE status NOT IN ('ended', 'failed');

CREATE INDEX IF NOT EXISTS idx_pair_sessions_owner
    ON pair_sessions (owner_user_id);
