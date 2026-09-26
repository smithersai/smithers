-- A send-upstream landing is merged by its GitHub pull request, never by a
-- Smithers append. This is its receipt: the pull request that carried the
-- landing's exact tip and GitHub's merge commit. One row per landing.
CREATE TABLE landing_github_merges (
    landing_request_id bigint PRIMARY KEY REFERENCES landing_requests(id) ON DELETE CASCADE,
    github_repository text NOT NULL,
    pull_number bigint NOT NULL CHECK (pull_number > 0),
    head_sha text NOT NULL,
    merge_commit text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
