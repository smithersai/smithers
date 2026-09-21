-- Revision: 20260718000500.
-- Release-asset object deletion is fallible and upload capabilities outlive an
-- API request.  Keep an exact, metered tombstone until both the staged and
-- final object names have been hard-purged after every signed capability has
-- expired.
ALTER TABLE release_assets
    DROP CONSTRAINT IF EXISTS release_assets_status_check;

ALTER TABLE release_assets
    ADD CONSTRAINT release_assets_status_check
    CHECK (status IN ('pending', 'ready', 'deleting'));

ALTER TABLE release_assets
    ADD COLUMN IF NOT EXISTS deletion_token VARCHAR(64),
    ADD COLUMN IF NOT EXISTS delete_after TIMESTAMPTZ;

ALTER TABLE release_assets
    DROP CONSTRAINT IF EXISTS release_assets_deletion_state_check;

ALTER TABLE release_assets
    ADD CONSTRAINT release_assets_deletion_state_check
    CHECK (
        (status = 'deleting' AND delete_after IS NOT NULL)
        OR (
            status <> 'deleting'
            AND deletion_token IS NULL
            AND delete_after IS NULL
        )
    );

CREATE INDEX IF NOT EXISTS idx_release_assets_cleanup
    ON release_assets (status, delete_after, created_at, updated_at, id);

-- A parent release cannot be removed with ON DELETE CASCADE until its blobs
-- are gone.  The intent hides the release from every normal read/mutation and
-- fences late AttachAsset calls without holding a database transaction open
-- across object-store requests.
CREATE TABLE IF NOT EXISTS release_deletion_intents (
    release_id      BIGINT PRIMARY KEY REFERENCES releases(id) ON DELETE CASCADE,
    deletion_token  VARCHAR(64),
    event_dispatched_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_release_deletion_intents_retry
    ON release_deletion_intents (updated_at, release_id);
