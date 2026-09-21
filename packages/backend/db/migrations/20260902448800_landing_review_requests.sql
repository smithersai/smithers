-- Explicit human and agent review requests for landing requests. Completed
-- requests remain as history; the partial unique indexes allow a reviewer to
-- be requested again after fulfillment or dismissal while preventing duplicate
-- active requests.
CREATE TABLE landing_review_requests (
    id                 BIGSERIAL PRIMARY KEY,
    landing_request_id BIGINT NOT NULL REFERENCES landing_requests(id) ON DELETE CASCADE,
    requested_by       BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reviewer_id        BIGINT REFERENCES users(id) ON DELETE RESTRICT,
    agent_name         VARCHAR(255),
    state              VARCHAR(16) NOT NULL DEFAULT 'requested'
                       CHECK (state IN ('requested', 'fulfilled', 'dismissed')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT landing_review_requests_principal_check CHECK (
        (reviewer_id IS NOT NULL AND agent_name IS NULL)
        OR
        (reviewer_id IS NULL AND agent_name IS NOT NULL AND length(btrim(agent_name)) > 0)
    )
);

CREATE INDEX idx_landing_review_requests_landing
    ON landing_review_requests (landing_request_id, created_at, id);

CREATE UNIQUE INDEX uq_landing_review_requests_requested_reviewer
    ON landing_review_requests (landing_request_id, reviewer_id)
    WHERE state = 'requested' AND reviewer_id IS NOT NULL;

CREATE UNIQUE INDEX uq_landing_review_requests_requested_agent
    ON landing_review_requests (landing_request_id, lower(agent_name))
    WHERE state = 'requested' AND agent_name IS NOT NULL;
