-- Pair prompt queue: row-per-prompt serial FIFO (decisions #3/#4/#5). Both
-- solo-composed and co-composed prompts land here, ordered by per-session
-- `seq`. `run_id` is the REAL gateway runId; its presence is the exactly-once
-- idempotency marker — a row with a run_id is NEVER re-dispatched, a takeover
-- only adopts observation of the existing run.
CREATE TABLE IF NOT EXISTS pair_prompt_queue (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id         TEXT NOT NULL REFERENCES pair_sessions(id) ON DELETE CASCADE,
    seq                BIGINT NOT NULL,
    author_user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source             TEXT NOT NULL CHECK (source IN ('solo', 'together')),
    body               TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'claimed', 'running', 'done', 'failed', 'canceled')),
    executor_client_id TEXT,
    claim_expires_at   TIMESTAMPTZ,
    run_id             TEXT,
    canceled_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at         TIMESTAMPTZ,
    finished_at        TIMESTAMPTZ,
    UNIQUE (session_id, seq)
);

-- Serial execution + single-claim-winner enforced as a DB invariant, not by
-- client courtesy: at most one 'claimed'/'running' row per session. A second
-- concurrent claim CAS is rejected by this index.
CREATE UNIQUE INDEX IF NOT EXISTS pair_prompt_queue_one_active
    ON pair_prompt_queue (session_id)
    WHERE status IN ('claimed', 'running');

CREATE INDEX IF NOT EXISTS idx_pair_prompt_queue_session_status
    ON pair_prompt_queue (session_id, status);
