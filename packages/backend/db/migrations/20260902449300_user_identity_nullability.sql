-- User-backed activity remains as a historical audit record after a user is
-- deleted. Match the nullable identity contract in db/schema.sql so agent
-- activity without a user row is also accepted by migration-built databases.

ALTER TABLE collaborators
    DROP CONSTRAINT IF EXISTS collaborators_repository_id_user_id_key,
    DROP CONSTRAINT IF EXISTS collaborators_user_id_fkey,
    ALTER COLUMN user_id DROP NOT NULL,
    ADD CONSTRAINT collaborators_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- Only live collaborator grants are unique. Deleted-user tombstones have no
-- user identity and therefore do not participate in uniqueness enforcement.
CREATE UNIQUE INDEX IF NOT EXISTS uq_collaborators_repo_user
    ON collaborators (repository_id, user_id)
    WHERE user_id IS NOT NULL;

ALTER TABLE issue_comments
    DROP CONSTRAINT IF EXISTS issue_comments_user_id_fkey,
    ALTER COLUMN user_id DROP NOT NULL,
    ADD CONSTRAINT issue_comments_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE landing_request_comments
    DROP CONSTRAINT IF EXISTS landing_request_comments_user_id_fkey,
    ALTER COLUMN user_id DROP NOT NULL,
    ADD CONSTRAINT landing_request_comments_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE landing_request_reviews
    DROP CONSTRAINT IF EXISTS landing_request_reviews_reviewer_id_fkey,
    ALTER COLUMN reviewer_id DROP NOT NULL,
    ADD CONSTRAINT landing_request_reviews_reviewer_id_fkey
        FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL;
