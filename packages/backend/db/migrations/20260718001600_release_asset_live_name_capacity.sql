-- atlas:txmode none

-- Revision: 20260718001600.
-- Deleting assets are durable object-cleanup tombstones, not attachments that
-- remain visible to users. Keep live names unique while allowing a replacement
-- upload to use the same name before the old tombstone's capability fence ends.
-- Build the replacement index before dropping the legacy constraint so live
-- name uniqueness is never relaxed during the migration.
CREATE UNIQUE INDEX CONCURRENTLY uq_release_assets_live_name
    ON release_assets (release_id, name)
    WHERE status <> 'deleting';

-- smithers:migration-contract-reviewed: release owner @williamcory, ticket PLUE-REVIEW-64, the replacement live-name index is active before this legacy constraint is removed.
ALTER TABLE release_assets
    DROP CONSTRAINT IF EXISTS release_assets_release_id_name_key;
