-- Revocation fan-out: one durable row per revocation event so a restarted pod
-- can catch up from its cursor, plus pg_notify('revocations') for latency.
-- Live consumers (SSE streams, terminal WebSockets, SSH sessions, gateway
-- relays, sandbox egress proxies) subscribe and terminate within seconds of
-- the event; the auth middleware re-validates against the same feed so a
-- revoked token or disabled user is refused on the next request regardless of
-- any expiry. No foreign keys: an event must outlive the row it revokes.
-- smithers:migration-contract-reviewed: additive tables only, no data movement
CREATE TABLE IF NOT EXISTS revocation_events (
    id              BIGSERIAL PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN (
                        'token_revoked', 'token_scopes_narrowed', 'user_disabled',
                        'collaborator_removed', 'workspace_share_removed',
                        'agent_session_cancelled', 'org_member_removed', 'gateway_revoked'
                    )),
    user_id         BIGINT,
    token_id        BIGINT,
    token_hash      TEXT NOT NULL DEFAULT '',
    repository_id   BIGINT,
    organization_id BIGINT,
    workspace_id    TEXT NOT NULL DEFAULT '',
    session_id      TEXT NOT NULL DEFAULT '',
    gateway_id      TEXT NOT NULL DEFAULT '',
    sandbox_ids     TEXT[] NOT NULL DEFAULT '{}'::text[],
    reason          TEXT NOT NULL DEFAULT '',
    actor_id        BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revocation_events_created_at
    ON revocation_events (created_at);
