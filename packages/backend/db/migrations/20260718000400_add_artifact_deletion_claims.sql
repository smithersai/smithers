-- Revision: 20260718000400.
-- Artifact blob deletion is fallible. Keep an exact, retryable metadata claim
-- until both the staged and final objects are gone so failed cleanup remains
-- metered and cannot race upload confirmation or same-name replacement.
-- smithers:migration-contract-reviewed: release owner @williamcory, ticket PLUE-REVIEW-84, replacing the status check is expand-only for the deleting lifecycle state.
ALTER TABLE workflow_artifacts
    DROP CONSTRAINT IF EXISTS workflow_artifacts_status_check;

ALTER TABLE workflow_artifacts
    ADD CONSTRAINT workflow_artifacts_status_check
    CHECK (status IN ('pending', 'ready', 'deleting'));

ALTER TABLE workflow_artifacts
    ADD COLUMN IF NOT EXISTS deletion_token VARCHAR(64);

ALTER TABLE workflow_artifacts
    ADD CONSTRAINT workflow_artifacts_deletion_state_check
    CHECK (status = 'deleting' OR deletion_token IS NULL);

CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_cleanup
    ON workflow_artifacts (status, created_at, expires_at, updated_at, id);

-- smithers:migration-contract-reviewed: release owner @williamcory, ticket PLUE-REVIEW-84, replacing the status check is expand-only for the deleting lifecycle state.
ALTER TABLE issue_artifacts
    DROP CONSTRAINT IF EXISTS issue_artifacts_status_check;

ALTER TABLE issue_artifacts
    ADD CONSTRAINT issue_artifacts_status_check
    CHECK (status IN ('pending', 'ready', 'deleting'));

ALTER TABLE issue_artifacts
    ADD COLUMN IF NOT EXISTS deletion_token VARCHAR(64);

ALTER TABLE issue_artifacts
    ADD CONSTRAINT issue_artifacts_deletion_state_check
    CHECK (status = 'deleting' OR deletion_token IS NULL);

CREATE INDEX IF NOT EXISTS idx_issue_artifacts_cleanup
    ON issue_artifacts (status, created_at, expires_at, updated_at, id);
