-- Smithers Pair: realtime multiplayer pair-coding room state.
--
-- One row per room holds the whole collaborative state (shared document,
-- conversation, presence with cursors/drafts, and the prompt collab buffer) as
-- a single jsonb blob, mutated under a row lock. Current clients subscribe
-- through the Electric `pair_state` shape; pg_notify on `pair_room_<id>` remains
-- for the legacy /api/pair/stream SSE endpoint.

CREATE TABLE IF NOT EXISTS pair_state (
    room_id    TEXT PRIMARY KEY,
    state      JSONB NOT NULL,
    version    BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
