-- Revision: 20260718002100.
-- Previous-version upload signers accepted arbitrary positive capability
-- lifetimes and wrote directly to final object names. Fail closed until an
-- operator has proved those signers are drained and attested the absolute
-- latest time at which any capability they issued can still be valid.
CREATE TABLE storage_legacy_capability_horizons (
    capability_kind VARCHAR(64) PRIMARY KEY,
    valid_until     TIMESTAMPTZ NOT NULL,
    attested_at     TIMESTAMPTZ,
    attested_by     TEXT,
    attestation     TEXT,
    CONSTRAINT storage_legacy_capability_horizons_attestation_check CHECK (
        (
            valid_until = 'infinity'::timestamptz
            AND attested_at IS NULL
            AND attested_by IS NULL
            AND attestation IS NULL
        )
        OR
        (
            isfinite(valid_until)
            AND attested_at IS NOT NULL
            AND BTRIM(COALESCE(attested_by, '')) <> ''
            AND BTRIM(COALESCE(attestation, '')) <> ''
        )
    )
);

INSERT INTO storage_legacy_capability_horizons (
    capability_kind, valid_until
) VALUES (
    'legacy-final-key-upload', 'infinity'::timestamptz
);

-- The first finite transition is an explicit operator attestation. Before it
-- passes, corrections may only extend the horizon. After it passes, purge may
-- already be in flight and the evidence gate is irreversible, so all changes
-- are rejected and late evidence requires incident handling.
CREATE OR REPLACE FUNCTION guard_storage_legacy_capability_horizon()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'storage legacy capability horizon cannot be deleted'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.capability_kind IS DISTINCT FROM OLD.capability_kind THEN
        RAISE EXCEPTION 'storage legacy capability kind is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NOT isfinite(NEW.valid_until) OR NEW.valid_until <= clock_timestamp() THEN
        RAISE EXCEPTION 'legacy capability horizon must be a finite future timestamp'
            USING ERRCODE = 'check_violation';
    END IF;
    IF isfinite(OLD.valid_until) AND OLD.valid_until <= clock_timestamp() THEN
        RAISE EXCEPTION 'legacy capability horizon cannot change after purge has opened'
            USING ERRCODE = 'check_violation';
    END IF;
    IF isfinite(OLD.valid_until) AND NEW.valid_until < OLD.valid_until THEN
        RAISE EXCEPTION 'legacy capability horizon can only be extended'
            USING ERRCODE = 'check_violation';
    END IF;
    IF BTRIM(COALESCE(NEW.attested_by, '')) = ''
       OR BTRIM(COALESCE(NEW.attestation, '')) = '' THEN
        RAISE EXCEPTION 'legacy capability horizon requires operator and evidence'
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.attested_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_storage_legacy_capability_horizon_guard
    BEFORE UPDATE OR DELETE ON storage_legacy_capability_horizons
    FOR EACH ROW EXECUTE FUNCTION guard_storage_legacy_capability_horizon();

-- requested_delete_after preserves the metadata-specific retention/retry
-- deadline while delete_after remains at a far-future finite sentinel for
-- compatibility with old queue workers. A finite value is required because
-- generated queue rows scan delete_after into time.Time. New workers consult
-- both the requested deadline and the attested global horizon.
ALTER TABLE storage_deletion_queue
    ADD COLUMN requested_delete_after TIMESTAMPTZ;

-- A staging key is safe to purge independently only when a distinct final key
-- for the same durable allocation proves the namespace derivation. Ambiguous
-- legacy/custom keys therefore remain final and fail closed.
CREATE OR REPLACE FUNCTION is_storage_staging_deletion_key(
    p_repository_id BIGINT,
    p_allocation_key TEXT,
    p_object_key TEXT
)
RETURNS BOOLEAN AS $$
    SELECT CASE
        WHEN p_allocation_key LIKE 'lfs:%' THEN
            p_object_key = format(
                'lfs-pending/%s/%s',
                split_part(p_allocation_key, ':', 2),
                split_part(p_allocation_key, ':', 3)
            )
            AND split_part(p_allocation_key, ':', 4) = ''
            AND EXISTS (
                SELECT 1
                FROM storage_deletion_queue AS sibling
                WHERE sibling.repository_id = p_repository_id
                  AND sibling.allocation_key = p_allocation_key
                  AND sibling.object_key <> p_object_key
            )
        WHEN p_allocation_key LIKE 'workflow-cache:%' THEN
            EXISTS (
                SELECT 1
                FROM storage_deletion_queue AS sibling
                WHERE sibling.repository_id = p_repository_id
                  AND sibling.allocation_key = p_allocation_key
                  AND sibling.object_key <> p_object_key
                  AND p_object_key = format(
                      'pending/workflow-caches/%s', LTRIM(sibling.object_key, '/')
                  )
            )
        WHEN p_allocation_key LIKE 'workflow-artifact:%' THEN
            EXISTS (
                SELECT 1
                FROM storage_deletion_queue AS sibling
                WHERE sibling.repository_id = p_repository_id
                  AND sibling.allocation_key = p_allocation_key
                  AND sibling.object_key <> p_object_key
                  AND p_object_key = format(
                      'pending/workflow-artifacts/%s', LTRIM(sibling.object_key, '/')
                  )
            )
        WHEN p_allocation_key LIKE 'issue-artifact:%' THEN
            EXISTS (
                SELECT 1
                FROM storage_deletion_queue AS sibling
                WHERE sibling.repository_id = p_repository_id
                  AND sibling.allocation_key = p_allocation_key
                  AND sibling.object_key <> p_object_key
                  AND p_object_key = format(
                      'pending/issue-artifacts/%s', LTRIM(sibling.object_key, '/')
                  )
            )
        WHEN p_allocation_key LIKE 'release-asset:%' THEN
            EXISTS (
                SELECT 1
                FROM storage_deletion_queue AS sibling
                WHERE sibling.repository_id = p_repository_id
                  AND sibling.allocation_key = p_allocation_key
                  AND sibling.object_key <> p_object_key
                  AND p_object_key = format(
                      'pending/release-assets/%s', LTRIM(sibling.object_key, '/')
                  )
            )
        ELSE FALSE
    END;
$$ LANGUAGE sql STABLE;

-- Fence every already-queued final key from previous-version workers while
-- retaining its original due time for the new horizon-aware worker.
UPDATE storage_deletion_queue AS queue
SET requested_delete_after = CASE
        WHEN is_storage_staging_deletion_key(
            queue.repository_id, queue.allocation_key, queue.object_key
        ) THEN NULL
        ELSE queue.delete_after
    END,
    delete_after = CASE
        WHEN is_storage_staging_deletion_key(
            queue.repository_id, queue.allocation_key, queue.object_key
        ) THEN queue.delete_after
        ELSE TIMESTAMPTZ '9999-12-31 23:59:59+00'
    END;

-- Queue insertion centralizes exact-key idempotency and applies the persisted
-- horizon to every final key. A missing control row is equivalent to infinity.
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
DECLARE
    v_requested_delete_after TIMESTAMPTZ;
    v_horizon TIMESTAMPTZ;
    v_is_staging BOOLEAN;
BEGIN
    IF p_repository_id IS NULL
        OR p_owner_type NOT IN ('user', 'org')
        OR p_owner_id IS NULL
        OR BTRIM(COALESCE(p_allocation_key, '')) = ''
        OR BTRIM(COALESCE(p_object_key, '')) = ''
    THEN
        RETURN;
    END IF;

    v_requested_delete_after := GREATEST(COALESCE(p_delete_after, NOW()), NOW());
    v_is_staging := is_storage_staging_deletion_key(
        p_repository_id, p_allocation_key, p_object_key
    );
    v_horizon := COALESCE(
        (
            SELECT horizon.valid_until
            FROM storage_legacy_capability_horizons AS horizon
            WHERE horizon.capability_kind = 'legacy-final-key-upload'
        ),
        'infinity'::timestamptz
    );

    INSERT INTO storage_deletion_queue (
        repository_id, owner_type, owner_id, allocation_key, object_key,
        size_bytes, delete_after, requested_delete_after
    ) VALUES (
        p_repository_id, p_owner_type, p_owner_id, p_allocation_key,
        p_object_key, GREATEST(COALESCE(p_size_bytes, 0), 0),
        CASE
            WHEN v_is_staging THEN v_requested_delete_after
            WHEN isfinite(v_horizon) THEN GREATEST(v_requested_delete_after, v_horizon)
            ELSE TIMESTAMPTZ '9999-12-31 23:59:59+00'
        END,
        CASE WHEN v_is_staging THEN NULL ELSE v_requested_delete_after END
    )
    ON CONFLICT (object_key) DO UPDATE
    SET repository_id = EXCLUDED.repository_id,
        owner_type = EXCLUDED.owner_type,
        owner_id = EXCLUDED.owner_id,
        allocation_key = EXCLUDED.allocation_key,
        size_bytes = GREATEST(storage_deletion_queue.size_bytes, EXCLUDED.size_bytes),
        delete_after = GREATEST(storage_deletion_queue.delete_after, EXCLUDED.delete_after),
        requested_delete_after = GREATEST(
            storage_deletion_queue.requested_delete_after,
            EXCLUDED.requested_delete_after
        ),
        claim_token = NULL,
        claimed_at = NULL,
        last_error = NULL,
        updated_at = NOW();

    -- Some legacy trigger paths enqueue the staging name before the final
    -- name. Once both exist, correct that conservative first classification
    -- without weakening any ambiguous single-key allocation.
    UPDATE storage_deletion_queue AS queue
    SET delete_after = queue.requested_delete_after,
        requested_delete_after = NULL,
        updated_at = NOW()
    WHERE queue.repository_id = p_repository_id
      AND queue.allocation_key = p_allocation_key
      AND queue.requested_delete_after IS NOT NULL
      AND is_storage_staging_deletion_key(
          queue.repository_id, queue.allocation_key, queue.object_key
      );
END;
$$ LANGUAGE plpgsql;
