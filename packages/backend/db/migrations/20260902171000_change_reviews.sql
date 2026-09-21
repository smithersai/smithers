-- Make landing reviews first-class revision-aware reviews on stable changes.
-- Human reviews continue to reference users; agent reviews reference the
-- session that produced them. Confidence is deliberately stored as a bucket
-- so no user-facing API can accidentally expose a numeric score.
ALTER TABLE landing_request_reviews
    ADD COLUMN reviewer_kind VARCHAR(16) NOT NULL DEFAULT 'human'
        CHECK (reviewer_kind IN ('human', 'agent')),
    ADD COLUMN agent_session_id UUID REFERENCES agent_sessions(id) ON DELETE SET NULL,
    ADD COLUMN confidence_bucket VARCHAR(16)
        CHECK (confidence_bucket IN ('high', 'medium', 'low')),
    ADD CONSTRAINT landing_request_reviews_principal_check CHECK (
        (reviewer_kind = 'human' AND agent_session_id IS NULL)
        OR reviewer_kind = 'agent'
    );

CREATE INDEX idx_landing_request_reviews_agent_session
    ON landing_request_reviews (agent_session_id)
    WHERE agent_session_id IS NOT NULL;
