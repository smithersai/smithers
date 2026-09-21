-- Bring databases built from the migration chain into exact catalog parity
-- with db/schema.sql. These differences previously escaped
-- TestMigrationsParity because it compared table names only.

-- The closed-beta rename left sequence and constraint names behind. Rename
-- them instead of teaching the parity test to ignore permanent catalog drift.
ALTER SEQUENCE beta_whitelist_entries_id_seq
    RENAME TO alpha_whitelist_entries_id_seq;
ALTER SEQUENCE beta_waitlist_entries_id_seq
    RENAME TO alpha_waitlist_entries_id_seq;

ALTER TABLE alpha_whitelist_entries
    RENAME CONSTRAINT beta_whitelist_entries_pkey
    TO alpha_whitelist_entries_pkey;
ALTER TABLE alpha_whitelist_entries
    RENAME CONSTRAINT beta_whitelist_entries_identity_type_check
    TO alpha_whitelist_entries_identity_type_check;
ALTER TABLE alpha_whitelist_entries
    RENAME CONSTRAINT beta_whitelist_entries_identity_type_lower_identity_value_key
    TO alpha_whitelist_entries_identity_type_lower_identity_value_key;
ALTER TABLE alpha_whitelist_entries
    RENAME CONSTRAINT beta_whitelist_entries_created_by_fkey
    TO alpha_whitelist_entries_created_by_fkey;

ALTER TABLE alpha_waitlist_entries
    RENAME CONSTRAINT beta_waitlist_entries_pkey
    TO alpha_waitlist_entries_pkey;
ALTER TABLE alpha_waitlist_entries
    RENAME CONSTRAINT beta_waitlist_entries_lower_email_key
    TO alpha_waitlist_entries_lower_email_key;
ALTER TABLE alpha_waitlist_entries
    RENAME CONSTRAINT beta_waitlist_entries_status_check
    TO alpha_waitlist_entries_status_check;
ALTER TABLE alpha_waitlist_entries
    RENAME CONSTRAINT beta_waitlist_entries_approved_by_fkey
    TO alpha_waitlist_entries_approved_by_fkey;

ALTER TABLE alpha_waitlist_entries
    ALTER COLUMN github_avatar_url DROP DEFAULT,
    ALTER COLUMN github_avatar_url TYPE TEXT,
    ALTER COLUMN github_avatar_url SET DEFAULT ''::text;

-- User-backed activity rows remain as historical audit records after a user
-- is deleted. Nullable principals and partial uniqueness are the contract
-- already used by sqlc and db/schema.sql.
ALTER TABLE collaborators
    DROP CONSTRAINT collaborators_repository_id_user_id_key,
    DROP CONSTRAINT collaborators_user_id_fkey,
    ALTER COLUMN user_id DROP NOT NULL,
    ADD CONSTRAINT collaborators_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX uq_collaborators_repo_user
    ON collaborators (repository_id, user_id)
    WHERE user_id IS NOT NULL;

ALTER TABLE issue_comments
    DROP CONSTRAINT issue_comments_user_id_fkey,
    ALTER COLUMN user_id DROP NOT NULL,
    ADD CONSTRAINT issue_comments_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE landing_request_comments
    DROP CONSTRAINT landing_request_comments_user_id_fkey,
    ALTER COLUMN user_id DROP NOT NULL,
    ADD CONSTRAINT landing_request_comments_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE landing_request_reviews
    DROP CONSTRAINT landing_request_reviews_reviewer_id_fkey,
    ALTER COLUMN reviewer_id DROP NOT NULL,
    ADD CONSTRAINT landing_request_reviews_reviewer_id_fkey
        FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE reactions
    DROP CONSTRAINT reactions_user_id_target_type_target_id_emoji_key,
    DROP CONSTRAINT reactions_user_id_fkey,
    ALTER COLUMN user_id DROP NOT NULL,
    ADD CONSTRAINT reactions_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX uq_reactions_user_target_emoji
    ON reactions (user_id, target_type, target_id, emoji)
    WHERE user_id IS NOT NULL;

ALTER TABLE mentions
    DROP CONSTRAINT mentions_comment_type_comment_id_mentioned_user_id_key,
    DROP CONSTRAINT mentions_mentioned_user_id_fkey,
    ALTER COLUMN mentioned_user_id DROP NOT NULL,
    ADD CONSTRAINT mentions_mentioned_user_id_fkey
        FOREIGN KEY (mentioned_user_id) REFERENCES users(id) ON DELETE SET NULL;
DROP INDEX idx_mentions_mentioned_user;
CREATE UNIQUE INDEX uq_mentions_comment
    ON mentions (comment_type, comment_id, mentioned_user_id)
    WHERE comment_id IS NOT NULL AND mentioned_user_id IS NOT NULL;
CREATE UNIQUE INDEX uq_mentions_body_issue
    ON mentions (comment_type, issue_id, mentioned_user_id)
    WHERE comment_id IS NULL AND issue_id IS NOT NULL AND mentioned_user_id IS NOT NULL;
CREATE UNIQUE INDEX uq_mentions_body_landing
    ON mentions (comment_type, landing_request_id, mentioned_user_id)
    WHERE comment_id IS NULL AND landing_request_id IS NOT NULL AND mentioned_user_id IS NOT NULL;
CREATE INDEX idx_mentions_mentioned_user
    ON mentions (mentioned_user_id, created_at DESC)
    WHERE mentioned_user_id IS NOT NULL;

-- Later OAuth2 application/query work hardened hashes and stopped storing
-- plaintext authorization codes. Complete that forward migration and remove
-- the legacy plaintext column after 000049 backfilled every hash.
ALTER TABLE oauth2_applications
    ALTER COLUMN client_id TYPE VARCHAR(64),
    ALTER COLUMN client_secret_hash TYPE VARCHAR(64),
    ALTER COLUMN redirect_uris SET DEFAULT '{}'::text[],
    ALTER COLUMN scopes SET DEFAULT '{}'::text[];

ALTER TABLE oauth2_authorization_codes
    DROP CONSTRAINT oauth2_authorization_codes_code_challenge_method_check;
UPDATE oauth2_authorization_codes
SET code_challenge = COALESCE(code_challenge, ''),
    code_challenge_method = COALESCE(code_challenge_method, '');
ALTER TABLE oauth2_authorization_codes
    DROP COLUMN code,
    ALTER COLUMN scopes SET DEFAULT '{}'::text[],
    ALTER COLUMN redirect_uri TYPE TEXT,
    ALTER COLUMN code_challenge TYPE TEXT,
    ALTER COLUMN code_challenge SET DEFAULT ''::text,
    ALTER COLUMN code_challenge SET NOT NULL,
    ALTER COLUMN code_challenge_method TYPE VARCHAR(16),
    ALTER COLUMN code_challenge_method SET DEFAULT ''::character varying,
    ALTER COLUMN code_challenge_method SET NOT NULL;

ALTER TABLE oauth2_access_tokens
    ALTER COLUMN token_hash TYPE VARCHAR(64),
    ALTER COLUMN scopes SET DEFAULT '{}'::text[];

ALTER TABLE oauth2_refresh_tokens
    ALTER COLUMN token_hash TYPE VARCHAR(64),
    ALTER COLUMN scopes DROP NOT NULL,
    ALTER COLUMN scopes DROP DEFAULT;

-- Match newer application states and query/index contracts that were added to
-- the snapshot without a production migration.
ALTER TABLE landing_requests
    DROP CONSTRAINT landing_requests_state_check,
    ADD CONSTRAINT landing_requests_state_check
        CHECK (state IN ('open', 'closed', 'merged', 'draft', 'queued', 'landing', 'failed'));

CREATE INDEX idx_repositories_forks_with_parent
    ON repositories (fork_id)
    WHERE is_fork = TRUE AND fork_id IS NOT NULL;

ALTER TABLE stack_changes
    DROP CONSTRAINT stack_changes_stack_id_position_key,
    ADD CONSTRAINT uq_stack_changes_stack_position
        UNIQUE (stack_id, position) DEFERRABLE INITIALLY DEFERRED;

-- These names changed as columns and contracts evolved. Keep the canonical
-- names so catalog parity catches future definition drift without reporting
-- historical aliases.
ALTER TABLE import_jobs
    RENAME CONSTRAINT ck_import_jobs_attempts TO import_jobs_attempts_check;
ALTER TABLE protected_bookmarks
    RENAME CONSTRAINT protected_bookmarks_required_approvals_check
    TO protected_bookmarks_require_human_approvals_check;
ALTER TABLE repository_agent_environments
    RENAME CONSTRAINT repository_agent_environments_provider_connection_preference_ch
    TO repository_agent_environment_provider_connection_preferen_check;

ALTER TABLE repository_storage_operations
    DROP CONSTRAINT repository_storage_operations_storage_set_id_fkey,
    ADD CONSTRAINT fk_repository_storage_operations_storage_set
        FOREIGN KEY (storage_set_id) REFERENCES repo_storage_sets(id) ON DELETE RESTRICT;
