-- Revision: 20260719144500.
-- App-machine timelines: the authoritative, Electric-synced copy of the multi
-- frontend's xstate machine history (SPEC.md §1.1 — "when authenticated, the
-- machine state is by default a durable object, syncing via the ElectricSQL
-- plumbing"). The client records every machine event (sequence-numbered,
-- positional) plus periodic serialized snapshots; time-travel forks seal the
-- abandoned future into a branch. Writes land over REST
-- (POST /api/app-timelines/{id}/events etc.); every member's local replica
-- converges by streaming the rows back through the app_timeline_* Electric
-- shapes (membership-authorized, mirroring the pair session shapes).
--
-- Ownership is modeled as a membership table from day one (pair_session_members
-- pattern) so a timeline can be shared with a second participant (Smithers
-- Pair, SPEC.md §6) without a schema redesign: the owner holds a live 'owner'
-- member row; future pairing adds 'editor'/'viewer' rows.

CREATE TABLE IF NOT EXISTS app_timelines (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- One timeline per (owner, client_key). 'default' is the app's single
    -- machine; other keys exist for future multi-machine clients.
    client_key    TEXT NOT NULL DEFAULT 'default'
                  CHECK (LENGTH(client_key) BETWEEN 1 AND 128),
    -- Dump-format version (multi's TimelineDump.version). Bumped only by a
    -- coordinated client+server migration.
    version       INTEGER NOT NULL DEFAULT 1,
    -- head_seq = number of events on the live line (next append lands at
    -- head_seq). Denormalized so appends can gap-check without COUNT(*).
    head_seq      BIGINT NOT NULL DEFAULT 0 CHECK (head_seq >= 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_timelines_owner_client
    ON app_timelines (owner_user_id, client_key)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS app_timeline_members (
    timeline_id UUID NOT NULL REFERENCES app_timelines(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_at  TIMESTAMPTZ,
    PRIMARY KEY (timeline_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS app_timeline_one_owner
    ON app_timeline_members (timeline_id)
    WHERE role = 'owner' AND removed_at IS NULL;

CREATE INDEX IF NOT EXISTS app_timeline_members_timeline_live
    ON app_timeline_members (timeline_id)
    WHERE removed_at IS NULL;

-- The live event line. seq is positional (multi's timeline stores events by
-- array index); an append at seq N atomically truncates every event >= N, so
-- (timeline_id, seq) rows always form a gapless 0..head_seq-1 prefix.
CREATE TABLE IF NOT EXISTS app_timeline_events (
    timeline_id UUID NOT NULL REFERENCES app_timelines(id) ON DELETE CASCADE,
    seq         BIGINT NOT NULL CHECK (seq >= 0),
    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (timeline_id, seq)
);

-- Sealed forks: when the client acts while rewound, the abandoned future is
-- sealed as a branch {from_seq, events[]} (multi's TimelineBranch). Branches
-- are append-only and identified positionally (ordinal = array index in the
-- dump); the sealed events ride as one JSONB array because branches are only
-- ever read whole.
CREATE TABLE IF NOT EXISTS app_timeline_branches (
    timeline_id UUID NOT NULL REFERENCES app_timelines(id) ON DELETE CASCADE,
    ordinal     INTEGER NOT NULL CHECK (ordinal >= 0),
    from_seq    BIGINT NOT NULL CHECK (from_seq >= 0),
    events      JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (timeline_id, ordinal)
);

-- Periodic serialized machine snapshots (xstate v5 inspection API) keyed by
-- the seq they were taken at, so a client can rehydrate from the newest
-- snapshot <= head and replay only the tail. Pruned to a small window by the
-- write path; an append that truncates events > seq also drops now-orphaned
-- snapshots.
CREATE TABLE IF NOT EXISTS app_timeline_snapshots (
    timeline_id UUID NOT NULL REFERENCES app_timelines(id) ON DELETE CASCADE,
    seq         BIGINT NOT NULL CHECK (seq >= 0),
    state       JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (timeline_id, seq)
);
