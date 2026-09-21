-- Revision: 20260718000300.
-- Cache blob deletion is fallible. Keep an exact, retryable metadata claim
-- until physical deletion succeeds so failed cleanup neither strands
-- unaccounted bytes nor lets finalize/upsert adopt an object being removed.
-- smithers:migration-contract-reviewed: release owner @williamcory, ticket PLUE-REVIEW-83, replacing the status check is expand-only for the deleting lifecycle state.
ALTER TABLE workflow_caches
    DROP CONSTRAINT IF EXISTS workflow_caches_status_check;

ALTER TABLE workflow_caches
    ADD CONSTRAINT workflow_caches_status_check
    CHECK (status IN ('pending', 'finalized', 'deleting'));

ALTER TABLE workflow_caches
    ADD COLUMN IF NOT EXISTS deletion_token VARCHAR(64);

ALTER TABLE workflow_caches
    ADD CONSTRAINT workflow_caches_deletion_state_check
    CHECK (status = 'deleting' OR deletion_token IS NULL);
