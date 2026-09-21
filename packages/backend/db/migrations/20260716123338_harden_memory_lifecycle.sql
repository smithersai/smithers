-- Persist promotion snapshots and transcript-ingest acceptance so retries resume
-- without re-reflecting a partial source set or appending a transcript twice.

ALTER TABLE memory_cleanup_tasks
    ADD COLUMN source_revision TEXT;

ALTER TABLE memory_promotion_tasks
    ADD COLUMN phase VARCHAR(16) NOT NULL DEFAULT 'snapshot'
        CHECK (phase IN ('snapshot', 'reflect', 'invalidate'));

CREATE TABLE memory_promotion_items (
    promotion_task_id BIGINT NOT NULL REFERENCES memory_promotion_tasks(id) ON DELETE CASCADE,
    memory_id TEXT NOT NULL,
    stream_tags TEXT[] NOT NULL DEFAULT '{}',
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalidated_at TIMESTAMPTZ,
    PRIMARY KEY (promotion_task_id, memory_id)
);

CREATE TABLE memory_ingest_batches (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    from_message_sequence BIGINT NOT NULL CHECK (from_message_sequence >= 0),
    through_message_sequence BIGINT NOT NULL CHECK (through_message_sequence >= from_message_sequence),
    document_id TEXT NOT NULL UNIQUE,
    payload_sha256 VARCHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    status VARCHAR(24) NOT NULL DEFAULT 'prepared'
        CHECK (status IN ('prepared', 'accepted', 'cursor_advanced')),
    operation_id TEXT,
    accepted_at TIMESTAMPTZ,
    cursor_advanced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, from_message_sequence, through_message_sequence)
);

CREATE INDEX idx_memory_ingest_batches_pending
    ON memory_ingest_batches(status, created_at, id)
    WHERE status <> 'cursor_advanced';
