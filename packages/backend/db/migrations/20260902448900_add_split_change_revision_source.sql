-- Server-side change splits rewrite the original change and create a second
-- change in one repository operation. Both resulting heads are revisioned
-- explicitly so review and finding consumers can distinguish them from push
-- ingestion.
-- smithers:migration-contract-reviewed: smithersai/plue#489, replacing the source check is expand-only because it adds 'split' and removes no previously allowed value.
ALTER TABLE change_revisions
    DROP CONSTRAINT change_revisions_source_check;

ALTER TABLE change_revisions
    ADD CONSTRAINT change_revisions_source_check
    CHECK (source IN ('push', 'rebase', 'agent', 'undo', 'revert', 'split'));
