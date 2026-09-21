-- Per-user reviewer feedback for change findings. A caller may revise their
-- feedback without creating duplicate rows, while aggregate counts remain
-- available to every reader of the finding.
CREATE TABLE finding_feedback (
    finding_id BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    useful     BOOLEAN NOT NULL,
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (finding_id, user_id)
);

-- Agent sessions dispatched from a finding retain their origin as structured
-- metadata. The partial unique index is the concurrency-safe guard that keeps
-- two requests from starting active work for the same finding.
ALTER TABLE agent_sessions
    ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object');

CREATE UNIQUE INDEX uq_agent_sessions_active_finding_dispatch
    ON agent_sessions ((metadata ->> 'finding_id'))
    WHERE status = 'active'
      AND deleted_at IS NULL
      AND metadata ? 'finding_id';
