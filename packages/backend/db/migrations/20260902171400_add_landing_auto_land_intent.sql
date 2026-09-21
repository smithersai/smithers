ALTER TABLE landing_requests
    ADD COLUMN auto_land_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN auto_land_set_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
    ADD COLUMN auto_land_set_at TIMESTAMPTZ,
    ADD COLUMN auto_land_checked_at TIMESTAMPTZ,
    ADD CONSTRAINT landing_requests_auto_land_intent_check CHECK (
        (auto_land_enabled AND auto_land_set_by IS NOT NULL AND auto_land_set_at IS NOT NULL)
        OR
        (NOT auto_land_enabled AND auto_land_set_by IS NULL AND auto_land_set_at IS NULL)
    );

CREATE INDEX idx_landing_requests_auto_land
    ON landing_requests (auto_land_checked_at ASC NULLS FIRST, auto_land_set_at ASC, id ASC)
    WHERE auto_land_enabled AND state = 'open';
