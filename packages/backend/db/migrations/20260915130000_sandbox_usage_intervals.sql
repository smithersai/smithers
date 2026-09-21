CREATE TABLE sandbox_usage_intervals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sandbox_kind text NOT NULL CHECK (sandbox_kind IN ('workspace', 'gateway', 'agent')),
    sandbox_id text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    CONSTRAINT sandbox_usage_intervals_order CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX sandbox_usage_intervals_open
    ON sandbox_usage_intervals (sandbox_kind, sandbox_id) WHERE ended_at IS NULL;
CREATE INDEX sandbox_usage_intervals_user_started
    ON sandbox_usage_intervals (user_id, started_at DESC);
