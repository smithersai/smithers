-- Server-generated backouts are first revisions of new stable changes. Keep
-- their provenance distinct from user pushes and operation-log undo rewrites.
-- smithers:migration-contract-reviewed: smithersai/plue#456, replacing the source check is expand-only because it adds 'revert' and removes no previously allowed value.
ALTER TABLE change_revisions
    DROP CONSTRAINT change_revisions_source_check;

ALTER TABLE change_revisions
    ADD CONSTRAINT change_revisions_source_check
    CHECK (source IN ('push', 'rebase', 'agent', 'undo', 'revert'));

-- Stable jj change IDs may be rewritten after landing. Capture the exact
-- commit and revision sequence that entered the target bookmark so a later
-- revert never backs out a newer incarnation of the same change.
ALTER TABLE landing_requests
    ADD COLUMN landed_revisions JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(landed_revisions) = 'object');
