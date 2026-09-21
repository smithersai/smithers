-- Native automatic replies commit with their replay receipt and outbox event.
-- comment_id intentionally survives comment deletion: replay never republishes.
CREATE TABLE repository_job_comments (
    dispatch_id uuid NOT NULL REFERENCES repository_job_dispatches(id) ON DELETE CASCADE,
    step text NOT NULL,
    body text NOT NULL,
    comment_id bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (dispatch_id, step)
);
CREATE INDEX repository_job_comments_comment ON repository_job_comments(comment_id);
