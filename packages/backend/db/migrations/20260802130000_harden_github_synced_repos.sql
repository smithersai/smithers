-- Revision: 20260802130000.
-- Hardening pass on the continuously-synced GitHub mirror registry:
--
--   github_repository_id  GitHub's immutable numeric repo id. Renames and
--                         transfers change owner/name but never this id, so
--                         webhook applies fall back to it and repair the slug
--                         instead of silently dropping deliveries.
--   consecutive_failures  counts back-to-back sync failures. The reconciler
--                         backs off exponentially on it and hard-fails the row
--                         (sync_state = 'failed') after 14 straight failures —
--                         the GitLab-importer-style kill switch. A hard-failed
--                         repo keeps serving last-good rows and keeps applying
--                         webhooks; only background reconciliation stops.
--   sync_state 'failed'   the kill-switch state, distinct from the operator's
--                         'disabled' (which also stops serving/applying).

ALTER TABLE github_synced_repos
    ADD COLUMN IF NOT EXISTS github_repository_id BIGINT,
    ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_github_synced_repos_github_id
    ON github_synced_repos (github_repository_id)
    WHERE github_repository_id IS NOT NULL;

ALTER TABLE github_synced_repos
    DROP CONSTRAINT IF EXISTS github_synced_repos_sync_state_check;
ALTER TABLE github_synced_repos
    ADD CONSTRAINT github_synced_repos_sync_state_check
    CHECK (sync_state IN ('pending', 'syncing', 'ready', 'error', 'failed', 'disabled'));
