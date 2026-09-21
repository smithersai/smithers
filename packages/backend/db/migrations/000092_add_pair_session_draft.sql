-- Pair session co-compose draft buffer (layer 3, decision #5). One live-synced
-- buffer per session; submitting it enqueues ONE 'together' pair_prompt_queue
-- row and clears the draft. Keystrokes land here (version-gated apply on the
-- CodeMirror editor); multi-caret positions live in pair_session_members.presence
-- — different rows, so keystrokes and caret beats never collide.
CREATE TABLE IF NOT EXISTS pair_session_draft (
    session_id TEXT PRIMARY KEY REFERENCES pair_sessions(id) ON DELETE CASCADE,
    content    TEXT NOT NULL DEFAULT '',
    version    BIGINT NOT NULL DEFAULT 0,
    updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
