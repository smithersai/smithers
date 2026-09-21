-- Split protected-bookmark review policy into independent human and agent
-- requirements, preserving every existing human approval threshold.
-- smithers:migration-contract-reviewed: smithersai/plue#462, renaming required_approvals is a same-release rename of a column no released client reads by name.
ALTER TABLE protected_bookmarks
    RENAME COLUMN required_approvals TO require_human_approvals;

ALTER TABLE protected_bookmarks
    ADD COLUMN require_agent_lgtm BOOLEAN NOT NULL DEFAULT FALSE;

-- Agent reviews are first-class, revision-bound review records. reviewer_kind,
-- confidence_bucket and commit_id already exist from the revision-anchored and
-- revision-aware review migrations; this adds the verdict and summary an agent
-- LGTM carries and the constraint that every agent review supplies all of them.
-- The legacy type/body columns remain populated so existing review consumers
-- continue to render and dismiss these rows while they adopt the richer fields.
ALTER TABLE landing_request_reviews
    ADD COLUMN verdict VARCHAR(16)
        CHECK (verdict IN ('lgtm', 'concerns')),
    ADD COLUMN summary TEXT NOT NULL DEFAULT '',
    ADD CONSTRAINT landing_request_reviews_agent_fields_check CHECK (
        reviewer_kind = 'human'
        OR (
            verdict IS NOT NULL
            AND confidence_bucket IS NOT NULL
            AND length(btrim(summary)) > 0
            AND length(btrim(commit_id)) > 0
        )
    );

CREATE INDEX idx_landing_request_reviews_agent_lgtm
    ON landing_request_reviews (landing_request_id, commit_id)
    WHERE reviewer_kind = 'agent'
      AND verdict = 'lgtm'
      AND state = 'submitted';
