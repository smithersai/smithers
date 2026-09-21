ALTER TABLE landing_request_comments
    ADD COLUMN state VARCHAR(32) NOT NULL DEFAULT 'open'
        CHECK (state IN ('open', 'done', 'resolved')),
    ADD COLUMN done_at TIMESTAMPTZ,
    ADD COLUMN done_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN resolved_in_revision JSONB NOT NULL DEFAULT 'null'::jsonb
        CHECK (resolved_in_revision = 'null'::jsonb OR jsonb_typeof(resolved_in_revision) = 'object'),
    ADD COLUMN resolved_at TIMESTAMPTZ,
    ADD COLUMN resolved_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_landing_request_comments_unresolved
    ON landing_request_comments (landing_request_id, id)
    WHERE state <> 'resolved';
