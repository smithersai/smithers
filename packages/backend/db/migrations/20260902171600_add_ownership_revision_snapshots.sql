ALTER TABLE changes
    ADD COLUMN revision_seq BIGINT NOT NULL DEFAULT 1 CHECK (revision_seq > 0);

ALTER TABLE landing_requests
    ADD COLUMN agent_authored BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE landing_request_reviews
    ADD COLUMN change_revisions JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(change_revisions) = 'object');

CREATE INDEX idx_landing_request_changes_change
    ON landing_request_changes (change_id, landing_request_id);
