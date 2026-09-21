-- Revision: 20260718001200.
-- Bound cleanup retries, keep reusable release tags out of durable tombstone
-- namespaces, and index the one-release legacy remediation reconciliation.

-- A release is hidden as soon as its deletion intent is durable, but the
-- original repository/tag uniqueness constraint must remain compatible with
-- the previous application version. Preserve the display tag in a companion
-- table instead of adding a column to release_deletion_intents: old binaries
-- use RETURNING * there and must keep seeing the original five-column shape.
-- The hidden parent moves to a deterministic internal tag that API validation
-- cannot admit (the leading unit-separator is a control rune).
CREATE TABLE IF NOT EXISTS release_deletion_tag_tombstones (
    release_id        BIGINT PRIMARY KEY REFERENCES releases(id) ON DELETE CASCADE,
    original_tag_name VARCHAR(255) NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO release_deletion_tag_tombstones (release_id, original_tag_name)
SELECT intent.release_id, release.tag_name
FROM release_deletion_intents AS intent
JOIN releases AS release ON release.id = intent.release_id
ON CONFLICT (release_id) DO NOTHING;

UPDATE releases AS release
SET tag_name = CHR(31) || 'smithers-deleted-release:' || release.id::text
FROM release_deletion_intents AS intent
WHERE release.id = intent.release_id
  AND release.tag_name <> CHR(31) || 'smithers-deleted-release:' || release.id::text;

CREATE OR REPLACE FUNCTION tombstone_release_tag_on_deletion_intent()
RETURNS TRIGGER AS $$
DECLARE
    v_current_tag VARCHAR(255);
    v_tombstone_tag VARCHAR(255) := CHR(31) || 'smithers-deleted-release:' || NEW.release_id::text;
BEGIN
    SELECT tag_name
    INTO v_current_tag
    FROM releases
    WHERE id = NEW.release_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- INSERT ... ON CONFLICT still executes BEFORE INSERT. The companion row
    -- is insert-only, so retries cannot replace the winning original with the
    -- internal tombstone they now observe on releases.
    IF v_current_tag <> v_tombstone_tag THEN
        INSERT INTO release_deletion_tag_tombstones (release_id, original_tag_name)
        VALUES (NEW.release_id, v_current_tag)
        ON CONFLICT (release_id) DO NOTHING;
    END IF;

    IF v_current_tag <> v_tombstone_tag THEN
        UPDATE releases
        SET tag_name = v_tombstone_tag
        WHERE id = NEW.release_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_release_deletion_intents_tombstone_tag
    ON release_deletion_intents;
CREATE TRIGGER trg_release_deletion_intents_tombstone_tag
    BEFORE INSERT ON release_deletion_intents
    FOR EACH ROW
    EXECUTE FUNCTION tombstone_release_tag_on_deletion_intent();

-- Previous-version pods do not filter release updates through the intent
-- table. Keep the hidden parent immutable at the database boundary so an old
-- update cannot reclaim the freed public tag from its replacement.
CREATE OR REPLACE FUNCTION guard_release_deletion_tombstone()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM release_deletion_intents
        WHERE release_id = OLD.id
    ) THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_releases_guard_deletion_tombstone ON releases;
CREATE TRIGGER trg_releases_guard_deletion_tombstone
    BEFORE UPDATE ON releases
    FOR EACH ROW
    EXECUTE FUNCTION guard_release_deletion_tombstone();

-- Retry scans order by the timestamp made fresh when a claim is released.
-- Partial indexes keep that fair ordering cheap without widening live reads.
CREATE INDEX IF NOT EXISTS idx_release_assets_deleting_retry
    ON release_assets (updated_at, id)
    WHERE status = 'deleting';

CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_deleting_retry
    ON workflow_artifacts (updated_at, id)
    WHERE status = 'deleting';

-- Claiming a pending cache changes its visible status to deleting before the
-- DELETE trigger runs. finalized_at is the stable origin discriminator: a
-- pending reservation has never been finalized even after that claim.
CREATE OR REPLACE FUNCTION enqueue_workflow_cache_storage_deletion()
RETURNS TRIGGER AS $$
DECLARE
    v_repo repositories%ROWTYPE;
BEGIN
    SELECT * INTO v_repo FROM repositories WHERE id = OLD.repository_id;
    IF FOUND THEN
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('workflow-cache:%s:%s', OLD.repository_id, OLD.object_key),
            OLD.object_key, OLD.object_size_bytes, NOW());
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('workflow-cache:%s:%s', OLD.repository_id, OLD.object_key),
            format('pending/workflow-caches/%s', LTRIM(OLD.object_key, '/')),
            OLD.object_size_bytes,
            GREATEST(NOW(), CASE
                WHEN OLD.finalized_at IS NULL THEN OLD.expires_at
                ELSE OLD.finalized_at + INTERVAL '7 days 15 minutes'
            END));
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Repository cascades enqueue children from the parent trigger before their
-- own DELETE triggers run. Apply the same origin discriminator there so an
-- already-claimed pending cache keeps its reservation expiry during a
-- repository deletion too.
CREATE OR REPLACE FUNCTION enqueue_repository_storage_deletions()
RETURNS TRIGGER AS $$
DECLARE
    v_owner_type TEXT := CASE WHEN OLD.user_id IS NOT NULL THEN 'user' ELSE 'org' END;
    v_owner_id BIGINT := COALESCE(OLD.user_id, OLD.org_id);
    v_row RECORD;
BEGIN
    PERFORM set_config(
        'smithers.deleting_repository_ids',
        COALESCE(NULLIF(current_setting('smithers.deleting_repository_ids', TRUE), ''), ',')
            || OLD.id::text || ',',
        TRUE
    );

    FOR v_row IN
        SELECT lo.oid, lo.size, lo.gcs_path, lo.created_at
        FROM lfs_objects AS lo
        WHERE lo.repository_id = OLD.id
    LOOP
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('lfs:%s:%s', OLD.id, v_row.oid), v_row.gcs_path,
            v_row.size, NOW());
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('lfs:%s:%s', OLD.id, v_row.oid),
            format('lfs-pending/%s/%s', OLD.id, v_row.oid), v_row.size,
            NOW() + INTERVAL '7 days 15 minutes');
    END LOOP;

    FOR v_row IN
        SELECT lur.oid, lur.size, lur.expires_at
        FROM lfs_upload_reservations AS lur
        WHERE lur.repository_id = OLD.id
    LOOP
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('lfs:%s:%s', OLD.id, v_row.oid),
            format('lfs-pending/%s/%s', OLD.id, v_row.oid), v_row.size,
            GREATEST(NOW(), v_row.expires_at));
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('lfs:%s:%s', OLD.id, v_row.oid),
            format('repos/%s/lfs/%s', OLD.id, v_row.oid), v_row.size, NOW());
    END LOOP;

    FOR v_row IN
        SELECT wc.id, wc.object_key, wc.object_size_bytes, wc.status,
               wc.expires_at, wc.finalized_at, wc.created_at
        FROM workflow_caches AS wc
        WHERE wc.repository_id = OLD.id
    LOOP
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('workflow-cache:%s:%s', OLD.id, v_row.object_key),
            v_row.object_key, v_row.object_size_bytes, NOW());
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('workflow-cache:%s:%s', OLD.id, v_row.object_key),
            format('pending/workflow-caches/%s', LTRIM(v_row.object_key, '/')),
            v_row.object_size_bytes,
            GREATEST(NOW(), CASE
                WHEN v_row.finalized_at IS NULL THEN v_row.expires_at
                ELSE v_row.finalized_at + INTERVAL '7 days 15 minutes'
            END));
    END LOOP;

    FOR v_row IN
        SELECT wa.id, wa.gcs_key, wa.size, wa.created_at
        FROM workflow_artifacts AS wa
        WHERE wa.repository_id = OLD.id
    LOOP
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('workflow-artifact:%s', v_row.id), v_row.gcs_key,
            v_row.size, NOW());
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('workflow-artifact:%s', v_row.id),
            format('pending/workflow-artifacts/%s', LTRIM(v_row.gcs_key, '/')),
            v_row.size,
            GREATEST(NOW(), v_row.created_at + INTERVAL '7 days 15 minutes'));
    END LOOP;

    FOR v_row IN
        SELECT ia.id, ia.gcs_key, ia.size, ia.created_at
        FROM issue_artifacts AS ia
        WHERE ia.repository_id = OLD.id
    LOOP
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('issue-artifact:%s', v_row.id), v_row.gcs_key,
            v_row.size, NOW());
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('issue-artifact:%s', v_row.id),
            format('pending/issue-artifacts/%s', LTRIM(v_row.gcs_key, '/')),
            v_row.size,
            GREATEST(NOW(), v_row.created_at + INTERVAL '7 days 15 minutes'));
    END LOOP;

    FOR v_row IN
        SELECT ra.id, ra.gcs_key, ra.size, ra.created_at
        FROM release_assets AS ra
        JOIN releases AS rel ON rel.id = ra.release_id
        WHERE rel.repository_id = OLD.id
    LOOP
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('release-asset:%s', v_row.id), v_row.gcs_key,
            v_row.size, NOW());
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('release-asset:%s', v_row.id),
            format('pending/release-assets/%s', LTRIM(v_row.gcs_key, '/')),
            v_row.size,
            GREATEST(NOW(), v_row.created_at + INTERVAL '7 days 15 minutes'));
    END LOOP;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;
