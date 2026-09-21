-- Revision: 20260718000600.
-- Object-store deletion is not transactional with PostgreSQL. Persist every
-- exact object key before its authoritative metadata can disappear so failed
-- or interrupted physical cleanup remains retryable and billable.
CREATE TABLE IF NOT EXISTS storage_deletion_queue (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL,
    owner_type       VARCHAR(16) NOT NULL CHECK (owner_type IN ('user', 'org')),
    owner_id         BIGINT NOT NULL,
    allocation_key  TEXT NOT NULL CHECK (BTRIM(allocation_key) <> ''),
    object_key      TEXT NOT NULL UNIQUE CHECK (BTRIM(object_key) <> ''),
    size_bytes      BIGINT NOT NULL CHECK (size_bytes >= 0),
    delete_after    TIMESTAMPTZ NOT NULL,
    claim_token     VARCHAR(64),
    claimed_at      TIMESTAMPTZ,
    attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT storage_deletion_queue_claim_state_check CHECK (
        (claim_token IS NULL AND claimed_at IS NULL)
        OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_storage_deletion_queue_due
    ON storage_deletion_queue (delete_after, claimed_at, id);
CREATE INDEX IF NOT EXISTS idx_storage_deletion_queue_owner
    ON storage_deletion_queue (owner_type, owner_id, allocation_key);
CREATE INDEX IF NOT EXISTS idx_storage_deletion_queue_repository
    ON storage_deletion_queue (repository_id, allocation_key);

-- Every upload capability is bounded to seven days by blob.MaxSignedURLExpiry
-- (the GCS V4 provider ceiling and the safe legacy-rollout horizon).
-- Retain pending names for another fifteen minutes so an in-flight PUT cannot
-- recreate an unmetered object after cleanup.
CREATE OR REPLACE FUNCTION enqueue_storage_deletion(
    p_repository_id BIGINT,
    p_owner_type TEXT,
    p_owner_id BIGINT,
    p_allocation_key TEXT,
    p_object_key TEXT,
    p_size_bytes BIGINT,
    p_delete_after TIMESTAMPTZ
)
RETURNS VOID AS $$
BEGIN
    IF p_repository_id IS NULL
        OR p_owner_type NOT IN ('user', 'org')
        OR p_owner_id IS NULL
        OR BTRIM(COALESCE(p_allocation_key, '')) = ''
        OR BTRIM(COALESCE(p_object_key, '')) = ''
    THEN
        RETURN;
    END IF;

    INSERT INTO storage_deletion_queue (
        repository_id,
        owner_type,
        owner_id,
        allocation_key,
        object_key,
        size_bytes,
        delete_after
    ) VALUES (
        p_repository_id,
        p_owner_type,
        p_owner_id,
        p_allocation_key,
        p_object_key,
        GREATEST(COALESCE(p_size_bytes, 0), 0),
        GREATEST(COALESCE(p_delete_after, NOW()), NOW())
    )
    ON CONFLICT (object_key) DO UPDATE
    SET repository_id = EXCLUDED.repository_id,
        owner_type = EXCLUDED.owner_type,
        owner_id = EXCLUDED.owner_id,
        allocation_key = EXCLUDED.allocation_key,
        size_bytes = GREATEST(storage_deletion_queue.size_bytes, EXCLUDED.size_bytes),
        delete_after = GREATEST(storage_deletion_queue.delete_after, EXCLUDED.delete_after),
        claim_token = NULL,
        claimed_at = NULL,
        last_error = NULL,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_repository_storage_deletions()
RETURNS TRIGGER AS $$
DECLARE
    v_owner_type TEXT := CASE WHEN OLD.user_id IS NOT NULL THEN 'user' ELSE 'org' END;
    v_owner_id BIGINT := COALESCE(OLD.user_id, OLD.org_id);
    v_row RECORD;
BEGIN
    -- Child BEFORE DELETE triggers normally avoid queueing an LFS key still
    -- owned by its counterpart row. Mark every repository in this transaction
    -- so cascades do not take that shortcut when both rows are disappearing.
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
        -- A reservation owns the deterministic eventual final name as well as
        -- its staging name, which fences key reuse during confirmation.
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
                WHEN v_row.status = 'pending' THEN v_row.expires_at
                ELSE COALESCE(v_row.finalized_at, v_row.created_at)
                    + INTERVAL '7 days 15 minutes'
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

CREATE OR REPLACE FUNCTION enqueue_lfs_object_storage_deletion()
RETURNS TRIGGER AS $$
DECLARE
    v_repo repositories%ROWTYPE;
BEGIN
    SELECT * INTO v_repo FROM repositories WHERE id = OLD.repository_id;
    IF FOUND THEN
        IF POSITION(
            ',' || OLD.repository_id::text || ',' IN
            COALESCE(current_setting('smithers.deleting_repository_ids', TRUE), '')
        ) = 0 AND TG_OP = 'DELETE' AND EXISTS (
            SELECT 1
            FROM lfs_upload_reservations
            WHERE repository_id = OLD.repository_id AND oid = OLD.oid
        ) THEN
            DELETE FROM storage_deletion_queue
            WHERE object_key IN (
                OLD.gcs_path,
                format('lfs-pending/%s/%s', OLD.repository_id, OLD.oid)
            );
            RETURN OLD;
        END IF;
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('lfs:%s:%s', OLD.repository_id, OLD.oid),
            OLD.gcs_path, OLD.size, NOW());
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('lfs:%s:%s', OLD.repository_id, OLD.oid),
            format('lfs-pending/%s/%s', OLD.repository_id, OLD.oid), OLD.size,
            NOW() + INTERVAL '7 days 15 minutes');
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_lfs_reservation_storage_deletion()
RETURNS TRIGGER AS $$
DECLARE
    v_repo repositories%ROWTYPE;
BEGIN
    SELECT * INTO v_repo FROM repositories WHERE id = OLD.repository_id;
    IF FOUND THEN
        IF POSITION(
            ',' || OLD.repository_id::text || ',' IN
            COALESCE(current_setting('smithers.deleting_repository_ids', TRUE), '')
        ) = 0 AND TG_OP = 'DELETE' AND EXISTS (
            SELECT 1
            FROM lfs_objects
            WHERE repository_id = OLD.repository_id AND oid = OLD.oid
        ) THEN
            DELETE FROM storage_deletion_queue
            WHERE object_key IN (
                format('lfs-pending/%s/%s', OLD.repository_id, OLD.oid),
                format('repos/%s/lfs/%s', OLD.repository_id, OLD.oid)
            );
            RETURN OLD;
        END IF;
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('lfs:%s:%s', OLD.repository_id, OLD.oid),
            format('lfs-pending/%s/%s', OLD.repository_id, OLD.oid), OLD.size,
            GREATEST(NOW(), OLD.expires_at));
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('lfs:%s:%s', OLD.repository_id, OLD.oid),
            format('repos/%s/lfs/%s', OLD.repository_id, OLD.oid), OLD.size,
            NOW());
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
                WHEN OLD.status = 'pending' THEN OLD.expires_at
                ELSE COALESCE(OLD.finalized_at, OLD.created_at)
                    + INTERVAL '7 days 15 minutes'
            END));
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_workflow_artifact_storage_deletion()
RETURNS TRIGGER AS $$
DECLARE
    v_repo repositories%ROWTYPE;
BEGIN
    SELECT * INTO v_repo FROM repositories WHERE id = OLD.repository_id;
    IF FOUND THEN
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('workflow-artifact:%s', OLD.id), OLD.gcs_key, OLD.size, NOW());
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('workflow-artifact:%s', OLD.id),
            format('pending/workflow-artifacts/%s', LTRIM(OLD.gcs_key, '/')),
            OLD.size, GREATEST(NOW(), OLD.created_at + INTERVAL '7 days 15 minutes'));
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_issue_artifact_storage_deletion()
RETURNS TRIGGER AS $$
DECLARE
    v_repo repositories%ROWTYPE;
BEGIN
    SELECT * INTO v_repo FROM repositories WHERE id = OLD.repository_id;
    IF FOUND THEN
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('issue-artifact:%s', OLD.id), OLD.gcs_key, OLD.size, NOW());
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('issue-artifact:%s', OLD.id),
            format('pending/issue-artifacts/%s', LTRIM(OLD.gcs_key, '/')),
            OLD.size, GREATEST(NOW(), OLD.created_at + INTERVAL '7 days 15 minutes'));
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_release_asset_storage_deletion()
RETURNS TRIGGER AS $$
DECLARE
    v_repository_id BIGINT;
    v_user_id BIGINT;
    v_org_id BIGINT;
BEGIN
    SELECT rel.repository_id, repo.user_id, repo.org_id
    INTO v_repository_id, v_user_id, v_org_id
    FROM releases AS rel
    JOIN repositories AS repo ON repo.id = rel.repository_id
    WHERE rel.id = OLD.release_id;
    IF FOUND THEN
        PERFORM enqueue_storage_deletion(v_repository_id,
            CASE WHEN v_user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_user_id, v_org_id), format('release-asset:%s', OLD.id),
            OLD.gcs_key, OLD.size, NOW());
        PERFORM enqueue_storage_deletion(v_repository_id,
            CASE WHEN v_user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_user_id, v_org_id), format('release-asset:%s', OLD.id),
            format('pending/release-assets/%s', LTRIM(OLD.gcs_key, '/')),
            OLD.size, GREATEST(NOW(), OLD.created_at + INTERVAL '7 days 15 minutes'));
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- A direct/legacy release DELETE cascades its assets. Enqueue from the parent
-- before that cascade because the child trigger cannot safely rely on joining
-- a parent row that is itself being removed by the same statement.
CREATE OR REPLACE FUNCTION enqueue_release_storage_deletions()
RETURNS TRIGGER AS $$
DECLARE
    v_user_id BIGINT;
    v_org_id BIGINT;
    v_row RECORD;
BEGIN
    SELECT user_id, org_id INTO v_user_id, v_org_id
    FROM repositories
    WHERE id = OLD.repository_id;
    IF NOT FOUND THEN
        RETURN OLD;
    END IF;

    FOR v_row IN
        SELECT id, gcs_key, size, created_at
        FROM release_assets
        WHERE release_id = OLD.id
    LOOP
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_user_id, v_org_id), format('release-asset:%s', v_row.id),
            v_row.gcs_key, v_row.size, NOW());
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_user_id, v_org_id), format('release-asset:%s', v_row.id),
            format('pending/release-assets/%s', LTRIM(v_row.gcs_key, '/')),
            v_row.size,
            GREATEST(NOW(), v_row.created_at + INTERVAL '7 days 15 minutes'));
    END LOOP;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- A newly metered LFS reservation supersedes old tombstones for both names.
-- DELETE takes a row lock, so it serializes with a cleaner that holds the same
-- queue row FOR UPDATE across its physical purge.
CREATE OR REPLACE FUNCTION resolve_recreated_lfs_storage_keys()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_TABLE_NAME = 'lfs_objects' THEN
        DELETE FROM storage_deletion_queue
        WHERE object_key IN (
            NEW.gcs_path,
            format('lfs-pending/%s/%s', NEW.repository_id, NEW.oid)
        );
    ELSE
        DELETE FROM storage_deletion_queue
        WHERE object_key IN (
            format('lfs-pending/%s/%s', NEW.repository_id, NEW.oid),
            format('repos/%s/lfs/%s', NEW.repository_id, NEW.oid)
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION retarget_repository_storage_deletions()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE storage_deletion_queue
    SET owner_type = CASE WHEN NEW.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
        owner_id = COALESCE(NEW.user_id, NEW.org_id),
        updated_at = NOW()
    WHERE repository_id = NEW.id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_repositories_enqueue_storage_deletions
    BEFORE DELETE ON repositories
    FOR EACH ROW EXECUTE FUNCTION enqueue_repository_storage_deletions();

CREATE TRIGGER trg_repositories_retarget_storage_deletions
    AFTER UPDATE OF user_id, org_id ON repositories
    FOR EACH ROW
    WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.org_id IS DISTINCT FROM NEW.org_id)
    EXECUTE FUNCTION retarget_repository_storage_deletions();

CREATE TRIGGER trg_lfs_objects_enqueue_storage_deletion
    BEFORE DELETE OR UPDATE OF repository_id, oid, gcs_path ON lfs_objects
    FOR EACH ROW EXECUTE FUNCTION enqueue_lfs_object_storage_deletion();
CREATE TRIGGER trg_lfs_reservations_enqueue_storage_deletion
    BEFORE DELETE OR UPDATE OF repository_id, oid ON lfs_upload_reservations
    FOR EACH ROW EXECUTE FUNCTION enqueue_lfs_reservation_storage_deletion();
CREATE TRIGGER trg_workflow_caches_enqueue_storage_deletion
    BEFORE DELETE OR UPDATE OF object_key ON workflow_caches
    FOR EACH ROW EXECUTE FUNCTION enqueue_workflow_cache_storage_deletion();
CREATE TRIGGER trg_workflow_artifacts_enqueue_storage_deletion
    BEFORE DELETE ON workflow_artifacts
    FOR EACH ROW EXECUTE FUNCTION enqueue_workflow_artifact_storage_deletion();
CREATE TRIGGER trg_issue_artifacts_enqueue_storage_deletion
    BEFORE DELETE ON issue_artifacts
    FOR EACH ROW EXECUTE FUNCTION enqueue_issue_artifact_storage_deletion();
CREATE TRIGGER trg_release_assets_enqueue_storage_deletion
    BEFORE DELETE ON release_assets
    FOR EACH ROW EXECUTE FUNCTION enqueue_release_asset_storage_deletion();
CREATE TRIGGER trg_releases_enqueue_storage_deletions
    BEFORE DELETE ON releases
    FOR EACH ROW EXECUTE FUNCTION enqueue_release_storage_deletions();

CREATE TRIGGER trg_lfs_objects_resolve_recreated_storage_keys
    BEFORE INSERT OR UPDATE OF repository_id, oid, gcs_path ON lfs_objects
    FOR EACH ROW EXECUTE FUNCTION resolve_recreated_lfs_storage_keys();
CREATE TRIGGER trg_lfs_reservations_resolve_recreated_storage_keys
    BEFORE INSERT OR UPDATE OF repository_id, oid ON lfs_upload_reservations
    FOR EACH ROW EXECUTE FUNCTION resolve_recreated_lfs_storage_keys();
