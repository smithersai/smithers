-- Reviews and inline comment threads are facts about the revision the client
-- displayed, not whichever revision happens to be current when the request is
-- processed. Existing rows predate revision pins and retain an empty sentinel.
ALTER TABLE landing_request_reviews
    ADD COLUMN commit_id VARCHAR(255) NOT NULL DEFAULT '';

ALTER TABLE landing_request_comments
    ADD COLUMN commit_id VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN anchor_hash VARCHAR(64) NOT NULL DEFAULT '';

