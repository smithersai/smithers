ALTER TABLE agent_sessions
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

ALTER TABLE agent_sessions
    DROP CONSTRAINT IF EXISTS agent_sessions_status_check;

ALTER TABLE agent_sessions
    ADD CONSTRAINT agent_sessions_status_check
    CHECK (status IN ('active', 'completed', 'failed', 'cancelled', 'timed_out'));
