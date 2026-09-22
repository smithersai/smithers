-- Plue hosted infrastructure baseline. Extracted from the previous full schema.
-- Product tables and durable repository storage operations are authored only by
-- db/product/migrations. Repository placement lives in plue_storage.
-- The old public.repo_storage_* tables remain transitional private state until
-- the Plue cutover migration finishes.
SET check_function_bodies = false;

-- Name: enqueue_issue_artifact_storage_deletion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_issue_artifact_storage_deletion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--

-- Name: enqueue_lfs_object_storage_deletion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_lfs_object_storage_deletion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_repo repositories%ROWTYPE;
BEGIN
    SELECT * INTO v_repo FROM repositories WHERE id = OLD.repository_id;
    IF FOUND THEN
        IF POSITION(
            ',' || OLD.repository_id::text || ',' IN
            COALESCE(current_setting('smithers.deleting_repository_ids', TRUE), '')
        ) = 0 AND TG_OP = 'DELETE' AND EXISTS (
            SELECT 1 FROM lfs_upload_reservations
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
$$;


--

-- Name: enqueue_lfs_reservation_storage_deletion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_lfs_reservation_storage_deletion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_repo repositories%ROWTYPE;
BEGIN
    SELECT * INTO v_repo FROM repositories WHERE id = OLD.repository_id;
    IF FOUND THEN
        IF POSITION(
            ',' || OLD.repository_id::text || ',' IN
            COALESCE(current_setting('smithers.deleting_repository_ids', TRUE), '')
        ) = 0 AND TG_OP = 'DELETE' AND EXISTS (
            SELECT 1 FROM lfs_objects
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
$$;


--

-- Name: enqueue_release_asset_storage_deletion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_release_asset_storage_deletion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--

-- Name: enqueue_release_storage_deletions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_release_storage_deletions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_user_id BIGINT;
    v_org_id BIGINT;
    v_row RECORD;
BEGIN
    SELECT user_id, org_id INTO v_user_id, v_org_id
    FROM repositories WHERE id = OLD.repository_id;
    IF NOT FOUND THEN
        RETURN OLD;
    END IF;
    FOR v_row IN
        SELECT id, gcs_key, size, created_at
        FROM release_assets WHERE release_id = OLD.id
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
$$;


--

-- Name: enqueue_repository_storage_deletions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_repository_storage_deletions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
        SELECT oid, size, gcs_path FROM lfs_objects WHERE repository_id = OLD.id
    LOOP
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('lfs:%s:%s', OLD.id, v_row.oid), v_row.gcs_path,
            v_row.size, NOW());
        -- Registered LFS objects can receive repair URLs long after creation.
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('lfs:%s:%s', OLD.id, v_row.oid),
            format('lfs-pending/%s/%s', OLD.id, v_row.oid), v_row.size,
            NOW() + INTERVAL '7 days 15 minutes');
    END LOOP;

    FOR v_row IN
        SELECT oid, size, expires_at
        FROM lfs_upload_reservations WHERE repository_id = OLD.id
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
        SELECT object_key, object_size_bytes, status, expires_at,
               finalized_at, created_at
        FROM workflow_caches WHERE repository_id = OLD.id
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
        SELECT id, gcs_key, size, created_at
        FROM workflow_artifacts WHERE repository_id = OLD.id
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
        SELECT id, gcs_key, size, created_at
        FROM issue_artifacts WHERE repository_id = OLD.id
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
$$;


--

-- Name: enqueue_storage_deletion(bigint, text, bigint, text, text, bigint, timestamptz); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_storage_deletion(p_repository_id bigint, p_owner_type text, p_owner_id bigint, p_allocation_key text, p_object_key text, p_size_bytes bigint, p_delete_after timestamptz) RETURNS void
    LANGUAGE plpgsql
    AS $$
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
$$;


--

-- Name: enqueue_workflow_artifact_storage_deletion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_workflow_artifact_storage_deletion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--

-- Name: enqueue_workflow_cache_storage_deletion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_workflow_cache_storage_deletion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--

-- Name: guard_storage_legacy_capability_horizon(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_storage_legacy_capability_horizon() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--

-- Name: guard_workflow_sandbox_terminal_claim(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_workflow_sandbox_terminal_claim() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    active_claim workflow_sandbox_claims%ROWTYPE;
BEGIN
    IF OLD.execution_plane IS DISTINCT FROM 'sandbox'
       OR NEW.status NOT IN ('success', 'failure') THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'queued' THEN
        RETURN NULL;
    END IF;

    SELECT *
    INTO active_claim
    FROM workflow_sandbox_claims
    WHERE workflow_run_id = OLD.id
      AND claim_token IS NOT NULL;

    IF FOUND
       AND (
           current_setting('smithers.workflow_sandbox_claim_token', true)
               IS DISTINCT FROM active_claim.claim_token::text
           OR current_setting('smithers.workflow_sandbox_claim_generation', true)
               IS DISTINCT FROM active_claim.generation::text
       ) THEN
        RETURN NULL;
    END IF;

    RETURN NEW;
END;
$$;


--

-- Name: guard_workspace_gateway_sharing(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_workspace_gateway_sharing() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE bound_workspace uuid;
BEGIN
    IF TG_TABLE_NAME = 'repo_gateways' THEN
        IF NEW.workspace_id IS NULL OR NEW.deleted_at IS NOT NULL
           OR NEW.status IN ('stopped', 'failed') THEN RETURN NEW; END IF;
        bound_workspace := NEW.workspace_id;
        PERFORM 1 FROM workspaces WHERE id = bound_workspace FOR UPDATE;
        IF EXISTS (SELECT 1 FROM workspace_shares WHERE workspace_id = bound_workspace AND level = 'write') THEN
            RAISE EXCEPTION 'workspace coding gateway conflicts with write sharing'
                USING ERRCODE = '23514', CONSTRAINT = 'workspace_gateway_private_execution';
        END IF;
    ELSE
        IF NEW.level <> 'write' THEN RETURN NEW; END IF;
        bound_workspace := NEW.workspace_id;
        PERFORM 1 FROM workspaces WHERE id = bound_workspace FOR UPDATE;
        IF EXISTS (SELECT 1 FROM repo_gateways WHERE workspace_id = bound_workspace
                   AND (auth_token_hash <> '' OR (deleted_at IS NULL AND status NOT IN ('stopped', 'failed')))) THEN
            RAISE EXCEPTION 'workspace write sharing conflicts with coding gateway'
                USING ERRCODE = '23514', CONSTRAINT = 'workspace_gateway_private_execution';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


--

-- Name: invalidate_workflow_sandbox_claim(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invalidate_workflow_sandbox_claim() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.execution_plane = 'sandbox'
       AND NEW.status IN ('success', 'failure', 'cancelled')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
        UPDATE workflow_sandbox_claims
        SET generation = generation + 1,
            claim_token = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL
        WHERE workflow_run_id = NEW.id
          AND claim_token IS NOT NULL;
    END IF;

    RETURN NULL;
END;
$$;


--

-- Name: is_storage_staging_deletion_key(bigint, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_storage_staging_deletion_key(p_repository_id bigint, p_allocation_key text, p_object_key text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
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
$$;


--

-- Name: sandbox_environment_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_environment_images (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    repository_id bigint,
    kind text NOT NULL,
    source text DEFAULT '.smithers/environment.nix'::text NOT NULL,
    source_revision text DEFAULT ''::text NOT NULL,
    closure_hash text NOT NULL,
    image text NOT NULL,
    status text DEFAULT 'ready'::text NOT NULL,
    created_by bigint,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT sandbox_environment_images_closure_hash_check CHECK ((closure_hash <> ''::text)),
    CONSTRAINT sandbox_environment_images_image_check CHECK ((image <> ''::text)),
    CONSTRAINT sandbox_environment_images_kind_check CHECK ((kind = ANY (ARRAY['vm'::text, 'desktop'::text]))),
    CONSTRAINT sandbox_environment_images_status_check CHECK ((status = ANY (ARRAY['ready'::text, 'retired'::text])))
);


--

-- Name: register_sandbox_environment_image(bigint, text, text, text, text, text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_sandbox_environment_image(p_repository_id bigint, p_kind text, p_source text, p_source_revision text, p_closure_hash text, p_image text, p_created_by bigint) RETURNS public.sandbox_environment_images
    LANGUAGE plpgsql
    AS $$
DECLARE
    registered sandbox_environment_images%ROWTYPE;
BEGIN
    IF p_repository_id IS NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('sandbox-base:' || p_kind, 0));
        UPDATE sandbox_environment_images
        SET status = 'retired', updated_at = NOW()
        WHERE repository_id IS NULL
          AND kind = p_kind
          AND closure_hash <> p_closure_hash
          AND status = 'ready';
    END IF;

    INSERT INTO sandbox_environment_images (
        repository_id, kind, source, source_revision, closure_hash, image, created_by
    ) VALUES (
        p_repository_id, p_kind,
        COALESCE(NULLIF(p_source, ''), '.smithers/environment.nix'),
        p_source_revision, p_closure_hash, p_image, p_created_by
    )
    ON CONFLICT ((COALESCE(repository_id, 0)), kind, closure_hash) DO UPDATE SET
        image = EXCLUDED.image,
        source = EXCLUDED.source,
        source_revision = EXCLUDED.source_revision,
        status = 'ready',
        updated_at = NOW()
    RETURNING * INTO registered;

    RETURN registered;
END;
$$;


--

-- Name: resolve_recreated_lfs_storage_keys(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_recreated_lfs_storage_keys() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--

-- Name: retarget_repository_storage_deletions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.retarget_repository_storage_deletions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE storage_deletion_queue
    SET owner_type = CASE WHEN NEW.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
        owner_id = COALESCE(NEW.user_id, NEW.org_id),
        updated_at = NOW()
    WHERE repository_id = NEW.id;
    RETURN NEW;
END;
$$;


--

-- Name: validate_repository_provisioning_operation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_repository_provisioning_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_owner_name TEXT;
    v_owner_type TEXT;
    v_owner_id BIGINT;
    v_source RECORD;
    v_authorized BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.repository_id IS DISTINCT FROM OLD.repository_id
           OR NEW.operation_type IS DISTINCT FROM OLD.operation_type
           OR NEW.token IS DISTINCT FROM OLD.token
           OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
           OR NEW.storage_set_id IS DISTINCT FROM OLD.storage_set_id
           OR NEW.owner_name IS DISTINCT FROM OLD.owner_name
           OR NEW.user_id IS DISTINCT FROM OLD.user_id
           OR NEW.org_id IS DISTINCT FROM OLD.org_id
           OR NEW.name IS DISTINCT FROM OLD.name
           OR NEW.lower_name IS DISTINCT FROM OLD.lower_name
           OR NEW.description IS DISTINCT FROM OLD.description
           OR NEW.is_public IS DISTINCT FROM OLD.is_public
           OR NEW.default_bookmark IS DISTINCT FROM OLD.default_bookmark
           OR NEW.auto_init IS DISTINCT FROM OLD.auto_init
           OR NEW.is_fork IS DISTINCT FROM OLD.is_fork
           OR NEW.fork_id IS DISTINCT FROM OLD.fork_id
           OR NEW.source_repository_id IS DISTINCT FROM OLD.source_repository_id
           OR NEW.source_owner IS DISTINCT FROM OLD.source_owner
           OR NEW.source_repo IS DISTINCT FROM OLD.source_repo
           OR NEW.source_storage_set_id IS DISTINCT FROM OLD.source_storage_set_id THEN
            RAISE EXCEPTION USING ERRCODE = '0A000',
                MESSAGE = 'repository provisioning identity is immutable';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.user_id IS NOT NULL THEN
        v_owner_type := 'user';
        v_owner_id := NEW.user_id;
        SELECT username INTO v_owner_name FROM users WHERE id = NEW.user_id FOR KEY SHARE;
    ELSE
        v_owner_type := 'org';
        v_owner_id := NEW.org_id;
        SELECT name INTO v_owner_name FROM organizations WHERE id = NEW.org_id FOR KEY SHARE;
    END IF;
    IF v_owner_name IS NULL OR v_owner_name IS DISTINCT FROM NEW.owner_name THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'repository provisioning owner identity does not match';
    END IF;
    PERFORM 1 FROM users WHERE id = NEW.actor_id FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
            MESSAGE = 'repository provisioning actor does not exist';
    END IF;
    IF NEW.user_id IS NOT NULL THEN
        IF NEW.actor_id IS DISTINCT FROM NEW.user_id THEN
            RAISE EXCEPTION USING ERRCODE = '42501',
                MESSAGE = 'repository provisioning actor cannot create for this user';
        END IF;
    ELSE
        PERFORM 1 FROM org_members
        WHERE organization_id = NEW.org_id AND user_id = NEW.actor_id AND role = 'owner'
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = '42501',
                MESSAGE = 'repository provisioning actor is not an organization owner';
        END IF;
    END IF;
    IF NEW.operation_type = 'fork' THEN
        SELECT r.user_id, r.org_id, r.name, p.storage_set_id, r.is_public,
               COALESCE(u.username, o.name) AS owner_name
        INTO v_source
        FROM repositories r
        LEFT JOIN plue_storage.repository_placements p ON p.repository_id = r.id AND p.state = 'published'
        LEFT JOIN users u ON u.id = r.user_id
        LEFT JOIN organizations o ON o.id = r.org_id
        WHERE r.id = NEW.source_repository_id
        FOR UPDATE OF r;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = '23514',
                MESSAGE = 'repository provisioning source identity does not match';
        END IF;
        IF v_source.owner_name IS DISTINCT FROM NEW.source_owner
           OR v_source.name IS DISTINCT FROM NEW.source_repo
           OR v_source.storage_set_id IS DISTINCT FROM NEW.source_storage_set_id THEN
            RAISE EXCEPTION USING ERRCODE = '23514',
                MESSAGE = 'repository provisioning source identity does not match';
        END IF;
        IF NOT v_source.is_public THEN
            -- Comparisons against an organization-owned source yield NULL for
            -- user_id. Normalize that three-valued result before using it as
            -- an authorization accumulator; otherwise every subsequent
            -- "IF NOT v_authorized" guard is skipped.
            v_authorized := COALESCE(v_source.user_id = NEW.actor_id, FALSE);
            IF NOT v_authorized AND v_source.org_id IS NOT NULL THEN
                SELECT TRUE INTO v_authorized
                FROM org_members om
                WHERE om.organization_id = v_source.org_id
                  AND om.user_id = NEW.actor_id
                  AND om.role = 'owner'
                FOR UPDATE OF om;
                v_authorized := COALESCE(v_authorized, FALSE);
            END IF;
            IF NOT v_authorized AND v_source.org_id IS NOT NULL THEN
                SELECT TRUE INTO v_authorized
                FROM team_repos tr
                JOIN teams t ON t.id = tr.team_id
                JOIN team_members tm ON tm.team_id = t.id
                JOIN org_members om
                  ON om.organization_id = t.organization_id
                 AND om.user_id = tm.user_id
                WHERE tr.repository_id = NEW.source_repository_id
                  AND tm.user_id = NEW.actor_id
                  AND t.organization_id = v_source.org_id
                  AND t.permission IN ('read', 'write', 'admin')
                LIMIT 1
                FOR UPDATE OF tr, t, tm, om;
                v_authorized := COALESCE(v_authorized, FALSE);
            END IF;
            IF NOT v_authorized THEN
                SELECT TRUE INTO v_authorized
                FROM collaborators c
                WHERE c.repository_id = NEW.source_repository_id
                  AND c.user_id = NEW.actor_id
                  AND c.permission IN ('read', 'write', 'admin')
                FOR UPDATE OF c;
                v_authorized := COALESCE(v_authorized, FALSE);
            END IF;
            IF NOT v_authorized THEN
                RAISE EXCEPTION USING ERRCODE = '42501',
                    MESSAGE = 'repository provisioning actor cannot read fork source';
            END IF;
        END IF;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
        FORMAT('repository-provision:%s:%s:%s', v_owner_type, v_owner_id, NEW.lower_name), 0
    ));
    IF EXISTS (
        SELECT 1 FROM repositories
        WHERE lower_name = NEW.lower_name
          AND ((NEW.user_id IS NOT NULL AND user_id = NEW.user_id)
               OR (NEW.org_id IS NOT NULL AND org_id = NEW.org_id))
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23505',
            MESSAGE = 'repository provisioning namespace is already occupied';
    END IF;
    RETURN NEW;
END;
$$;


--

-- Name: _id_remap; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._id_remap (
    local_id text NOT NULL,
    remote_id text,
    resource_type text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    remapped_at timestamptz
);


--

-- Name: _sync_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._sync_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    method character varying(8) NOT NULL,
    path text NOT NULL,
    body jsonb,
    local_id text,
    remote_id text,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    error_message text DEFAULT ''::text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    synced_at timestamptz,
    CONSTRAINT _sync_queue_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'synced'::character varying, 'conflict'::character varying, 'failed'::character varying])::text[])))
);


--

-- Name: alert_incident_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_incident_deliveries (
    incident_id text NOT NULL,
    canonical_incident_id bigint NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    closed_at timestamptz
);


--

-- Name: alert_incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_incidents (
    id bigint NOT NULL,
    incident_id text NOT NULL,
    policy_name text NOT NULL,
    condition_name text DEFAULT ''::text NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    incident_url text DEFAULT ''::text NOT NULL,
    runbook text DEFAULT ''::text NOT NULL,
    workflow text DEFAULT ''::text NOT NULL,
    remediation_pr_url text DEFAULT ''::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    resolved_at timestamptz,
    updated_at timestamptz DEFAULT now() NOT NULL,
    source text DEFAULT 'monitoring'::text NOT NULL,
    occurrences integer DEFAULT 1 NOT NULL,
    last_seen_at timestamptz DEFAULT now() NOT NULL,
    acknowledged_at timestamptz,
    acknowledged_by text,
    snoozed_until timestamptz,
    resolved_by text,
    resolution_note text,
    CONSTRAINT alert_incidents_state_check CHECK ((state = ANY (ARRAY['open'::text, 'remediating'::text, 'pr_opened'::text, 'resolved'::text, 'failed'::text])))
);


--

-- Name: alert_incidents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alert_incidents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: alert_incidents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alert_incidents_id_seq OWNED BY public.alert_incidents.id;


--

-- Name: alert_remediation_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_remediation_jobs (
    id bigint NOT NULL,
    incident_id bigint NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    error text DEFAULT ''::text NOT NULL,
    available_at timestamptz DEFAULT now() NOT NULL,
    processed_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    dispatch_token text DEFAULT encode(public.gen_random_bytes(32), 'hex'::text) NOT NULL,
    workflow_run_id bigint,
    CONSTRAINT alert_remediation_jobs_dispatch_token_check CHECK ((dispatch_token ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT alert_remediation_jobs_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'done'::character varying, 'failed'::character varying])::text[])))
);


--

-- Name: alert_remediation_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alert_remediation_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: alert_remediation_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alert_remediation_jobs_id_seq OWNED BY public.alert_remediation_jobs.id;


--

-- Name: canary_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canary_results (
    id bigint NOT NULL,
    suite character varying(32) NOT NULL,
    test_name character varying(128) NOT NULL,
    status character varying(16) NOT NULL,
    duration_seconds double precision DEFAULT 0 NOT NULL,
    error_message text DEFAULT ''::text NOT NULL,
    run_id character varying(128) DEFAULT ''::character varying NOT NULL,
    reported_at timestamptz DEFAULT now() NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT canary_results_duration_seconds_check CHECK ((duration_seconds >= (0)::double precision)),
    CONSTRAINT canary_results_status_check CHECK (((status)::text = ANY ((ARRAY['success'::character varying, 'failure'::character varying])::text[])))
);


--

-- Name: canary_results_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.canary_results_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: canary_results_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.canary_results_id_seq OWNED BY public.canary_results.id;


--

-- Name: github_proxy_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.github_proxy_audit_log (
    id bigint NOT NULL,
    workflow_run_id bigint NOT NULL,
    method character varying(16) NOT NULL,
    path text NOT NULL,
    status_code integer NOT NULL,
    decision character varying(16) NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT github_proxy_audit_log_decision_check CHECK (((decision)::text = ANY ((ARRAY['allow'::character varying, 'deny'::character varying])::text[])))
);


--

-- Name: github_proxy_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.github_proxy_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: github_proxy_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.github_proxy_audit_log_id_seq OWNED BY public.github_proxy_audit_log.id;


--

-- Name: legacy_mutation_fence_control; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legacy_mutation_fence_control (
    singleton boolean DEFAULT true NOT NULL,
    enforce_repository_storage boolean DEFAULT false CONSTRAINT legacy_mutation_fence_contr_enforce_repository_storage_not_null NOT NULL,
    enforce_release_deletion boolean DEFAULT false NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT legacy_mutation_fence_control_singleton_check CHECK (singleton)
);


--

-- Name: memory_cleanup_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_cleanup_items (
    cleanup_task_id bigint NOT NULL,
    memory_id text NOT NULL,
    captured_at timestamptz DEFAULT now() NOT NULL,
    invalidated_at timestamptz
);


--

-- Name: memory_cleanup_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_cleanup_tasks (
    id bigint NOT NULL,
    task_kind character varying(24) NOT NULL,
    target_id bigint NOT NULL,
    bookmark character varying(255),
    source_revision text,
    deletion_event_at timestamptz NOT NULL,
    snapshot_completed_at timestamptz,
    idempotency_key text NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    last_error_class character varying(64),
    available_at timestamptz DEFAULT now() NOT NULL,
    lease_expires_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT memory_cleanup_tasks_attempt_check CHECK ((attempt >= 0)),
    CONSTRAINT memory_cleanup_tasks_check CHECK (((((task_kind)::text = 'branch'::text) AND (bookmark IS NOT NULL)) OR (((task_kind)::text = ANY ((ARRAY['project_bank'::character varying, 'user_bank'::character varying])::text[])) AND (bookmark IS NULL)))),
    CONSTRAINT memory_cleanup_tasks_status_check CHECK (((status)::text = ANY ((ARRAY['awaiting_source_delete'::character varying, 'pending'::character varying, 'running'::character varying, 'done'::character varying])::text[]))),
    CONSTRAINT memory_cleanup_tasks_target_id_check CHECK ((target_id > 0)),
    CONSTRAINT memory_cleanup_tasks_task_kind_check CHECK (((task_kind)::text = ANY ((ARRAY['branch'::character varying, 'project_bank'::character varying, 'user_bank'::character varying])::text[])))
);


--

-- Name: memory_cleanup_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.memory_cleanup_tasks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: memory_cleanup_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.memory_cleanup_tasks_id_seq OWNED BY public.memory_cleanup_tasks.id;


--

-- Name: memory_ingest_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_ingest_batches (
    id bigint NOT NULL,
    session_id uuid NOT NULL,
    from_message_sequence bigint NOT NULL,
    through_message_sequence bigint NOT NULL,
    document_id text NOT NULL,
    payload_sha256 character varying(64) NOT NULL,
    status character varying(24) DEFAULT 'prepared'::character varying NOT NULL,
    operation_id text,
    accepted_at timestamptz,
    cursor_advanced_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT memory_ingest_batches_check CHECK ((through_message_sequence >= from_message_sequence)),
    CONSTRAINT memory_ingest_batches_from_message_sequence_check CHECK ((from_message_sequence >= 0)),
    CONSTRAINT memory_ingest_batches_payload_sha256_check CHECK (((payload_sha256)::text ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT memory_ingest_batches_status_check CHECK (((status)::text = ANY ((ARRAY['prepared'::character varying, 'accepted'::character varying, 'cursor_advanced'::character varying])::text[])))
);


--

-- Name: memory_ingest_batches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.memory_ingest_batches_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: memory_ingest_batches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.memory_ingest_batches_id_seq OWNED BY public.memory_ingest_batches.id;


--

-- Name: memory_ingest_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_ingest_cursors (
    session_id uuid NOT NULL,
    document_id text NOT NULL,
    last_message_sequence bigint DEFAULT '-1'::integer NOT NULL,
    last_operation_id text,
    accepted_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT memory_ingest_cursors_last_message_sequence_check CHECK ((last_message_sequence >= '-1'::integer))
);


--

-- Name: memory_maintenance_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_maintenance_cursors (
    maintenance_kind character varying(64) NOT NULL,
    last_bank_id text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT memory_maintenance_cursors_last_bank_id_check CHECK ((btrim(last_bank_id) <> ''::text))
);


--

-- Name: memory_promotion_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_promotion_items (
    promotion_task_id bigint NOT NULL,
    memory_id text NOT NULL,
    stream_tags text[] DEFAULT '{}'::text[] NOT NULL,
    captured_at timestamptz DEFAULT now() NOT NULL,
    invalidated_at timestamptz
);


--

-- Name: memory_promotion_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_promotion_tasks (
    id bigint NOT NULL,
    landing_request_id bigint NOT NULL,
    repository_id bigint NOT NULL,
    source_bookmark character varying(255) NOT NULL,
    target_bookmark character varying(255) NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    phase character varying(16) DEFAULT 'snapshot'::character varying NOT NULL,
    outcome character varying(16),
    attempt integer DEFAULT 0 NOT NULL,
    last_error text,
    operation_id text,
    available_at timestamptz DEFAULT now() NOT NULL,
    lease_expires_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT memory_promotion_tasks_attempt_check CHECK ((attempt >= 0)),
    CONSTRAINT memory_promotion_tasks_outcome_check CHECK (((outcome)::text = ANY ((ARRAY['promoted'::character varying, 'empty'::character varying, 'skipped'::character varying])::text[]))),
    CONSTRAINT memory_promotion_tasks_phase_check CHECK (((phase)::text = ANY ((ARRAY['snapshot'::character varying, 'reflect'::character varying, 'invalidate'::character varying])::text[]))),
    CONSTRAINT memory_promotion_tasks_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'done'::character varying, 'failed'::character varying])::text[])))
);


--

-- Name: memory_promotion_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.memory_promotion_tasks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: memory_promotion_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.memory_promotion_tasks_id_seq OWNED BY public.memory_promotion_tasks.id;


--

-- Name: memory_provisioning_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_provisioning_tasks (
    id bigint NOT NULL,
    target_kind character varying(16) NOT NULL,
    target_id bigint NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    last_error text,
    available_at timestamptz DEFAULT now() NOT NULL,
    lease_expires_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT memory_provisioning_tasks_attempt_check CHECK ((attempt >= 0)),
    CONSTRAINT memory_provisioning_tasks_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'done'::character varying, 'failed'::character varying])::text[]))),
    CONSTRAINT memory_provisioning_tasks_target_id_check CHECK ((target_id > 0)),
    CONSTRAINT memory_provisioning_tasks_target_kind_check CHECK (((target_kind)::text = ANY ((ARRAY['user'::character varying, 'project'::character varying])::text[])))
);


--

-- Name: memory_provisioning_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.memory_provisioning_tasks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: memory_provisioning_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.memory_provisioning_tasks_id_seq OWNED BY public.memory_provisioning_tasks.id;


--

-- Name: memory_restore_manifests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_restore_manifests (
    restore_id character varying(128) NOT NULL,
    target_kind character varying(16) NOT NULL,
    target_id bigint NOT NULL,
    operation_id text NOT NULL,
    source_manifest jsonb NOT NULL,
    verified_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT memory_restore_manifests_operation_id_check CHECK ((btrim(operation_id) <> ''::text)),
    CONSTRAINT memory_restore_manifests_restore_id_check CHECK (((restore_id)::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'::text)),
    CONSTRAINT memory_restore_manifests_source_manifest_check CHECK ((jsonb_typeof(source_manifest) = 'object'::text)),
    CONSTRAINT memory_restore_manifests_target_id_check CHECK ((target_id > 0)),
    CONSTRAINT memory_restore_manifests_target_kind_check CHECK (((target_kind)::text = ANY ((ARRAY['user'::character varying, 'project'::character varying])::text[])))
);


--

-- Name: memory_write_freezes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_write_freezes (
    id bigint NOT NULL,
    target_kind character varying(16) NOT NULL,
    target_id bigint,
    lease_token uuid DEFAULT gen_random_uuid() NOT NULL,
    operator_id text NOT NULL,
    reason text NOT NULL,
    acquired_at timestamptz DEFAULT now() NOT NULL,
    expires_at timestamptz NOT NULL,
    released_at timestamptz,
    CONSTRAINT memory_write_freezes_check CHECK (((((target_kind)::text = 'all'::text) AND (target_id IS NULL)) OR (((target_kind)::text = ANY ((ARRAY['user'::character varying, 'project'::character varying])::text[])) AND (target_id > 0)))),
    CONSTRAINT memory_write_freezes_check1 CHECK (((expires_at > acquired_at) AND (expires_at <= (acquired_at + '02:00:00'::interval)))),
    CONSTRAINT memory_write_freezes_target_kind_check CHECK (((target_kind)::text = ANY ((ARRAY['user'::character varying, 'project'::character varying, 'all'::character varying])::text[])))
);


--

-- Name: memory_write_freezes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.memory_write_freezes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: memory_write_freezes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.memory_write_freezes_id_seq OWNED BY public.memory_write_freezes.id;


--

-- Name: repo_gateways; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repo_gateways (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    repository_id bigint NOT NULL,
    user_id bigint NOT NULL,
    workspace_id uuid,
    vm_id text DEFAULT ''::text NOT NULL,
    base_url text DEFAULT ''::text NOT NULL,
    auth_token_hash text DEFAULT ''::text NOT NULL,
    auth_token_ciphertext text DEFAULT ''::text NOT NULL,
    landing_token_id bigint,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    last_activity_at timestamptz DEFAULT now() NOT NULL,
    deleted_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT repo_gateways_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'starting'::character varying, 'running'::character varying, 'suspended'::character varying, 'stopped'::character varying, 'failed'::character varying])::text[])))
);


--

-- Name: repo_replicas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repo_replicas (
    repository_id bigint NOT NULL,
    node_id text NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    state_hash text DEFAULT ''::text NOT NULL,
    state character varying(16) DEFAULT 'stale'::character varying NOT NULL,
    last_verified_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT repo_replicas_generation_check CHECK ((generation >= 0)),
    CONSTRAINT repo_replicas_state_check CHECK (((state)::text = ANY ((ARRAY['current'::character varying, 'stale'::character varying, 'repairing'::character varying, 'missing'::character varying])::text[])))
);


--

-- Name: repo_replication_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repo_replication_jobs (
    id bigint NOT NULL,
    repository_id bigint NOT NULL,
    source_node_id text,
    target_node_id text NOT NULL,
    generation bigint NOT NULL,
    state character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    error text DEFAULT ''::text NOT NULL,
    run_after timestamptz DEFAULT now() NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT repo_replication_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT repo_replication_jobs_generation_check CHECK ((generation >= 0)),
    CONSTRAINT repo_replication_jobs_state_check CHECK (((state)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'succeeded'::character varying, 'failed'::character varying])::text[])))
);


--

-- Name: repo_replication_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.repo_replication_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: repo_replication_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.repo_replication_jobs_id_seq OWNED BY public.repo_replication_jobs.id;


--

-- Name: repo_storage_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repo_storage_nodes (
    id text NOT NULL,
    storage_set_id text NOT NULL,
    url text NOT NULL,
    zone text DEFAULT ''::text NOT NULL,
    state character varying(16) DEFAULT 'active'::character varying NOT NULL,
    last_seen_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT repo_storage_nodes_state_check CHECK (((state)::text = ANY ((ARRAY['active'::character varying, 'draining'::character varying, 'offline'::character varying])::text[])))
);


--

-- Name: repo_storage_sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repo_storage_sets (
    id text NOT NULL,
    desired_replicas integer DEFAULT 3 NOT NULL,
    write_quorum integer DEFAULT 2 NOT NULL,
    state character varying(16) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT repo_storage_sets_check CHECK ((write_quorum <= desired_replicas)),
    CONSTRAINT repo_storage_sets_desired_replicas_check CHECK ((desired_replicas > 0)),
    CONSTRAINT repo_storage_sets_state_check CHECK (((state)::text = ANY ((ARRAY['active'::character varying, 'draining'::character varying, 'disabled'::character varying])::text[]))),
    CONSTRAINT repo_storage_sets_write_quorum_check CHECK ((write_quorum > 0))
);


--

-- Name: repo_write_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repo_write_locks (
    repository_id bigint NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    locked_by text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT repo_write_locks_generation_check CHECK ((generation >= 0))
);


--

-- Name: repository_provisioning_control; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repository_provisioning_control (
    singleton boolean DEFAULT true NOT NULL,
    enforce_insert_fence boolean DEFAULT false NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT repository_provisioning_control_singleton_check CHECK (singleton)
);


--

-- Name: repository_provisioning_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repository_provisioning_operations (
    repository_id bigint NOT NULL,
    operation_type character varying(16) NOT NULL,
    token character varying(64) NOT NULL,
    actor_id bigint NOT NULL,
    storage_set_id text NOT NULL,
    owner_name character varying(255) NOT NULL,
    user_id bigint,
    org_id bigint,
    name character varying(255) NOT NULL,
    lower_name character varying(255) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    is_public boolean NOT NULL,
    default_bookmark character varying(255) NOT NULL,
    auto_init boolean DEFAULT false NOT NULL,
    is_fork boolean DEFAULT false NOT NULL,
    fork_id bigint,
    source_repository_id bigint,
    source_owner character varying(255),
    source_repo character varying(255),
    source_storage_set_id text,
    publish_ready boolean DEFAULT false NOT NULL,
    claim_token character varying(64),
    claimed_at timestamptz,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT repository_provisioning_operations_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT repository_provisioning_operations_check CHECK ((num_nonnulls(user_id, org_id) = 1)),
    CONSTRAINT repository_provisioning_operations_check1 CHECK (((user_id IS NULL) OR (actor_id = user_id))),
    CONSTRAINT repository_provisioning_operations_check2 CHECK (((lower_name)::text = lower((name)::text))),
    CONSTRAINT repository_provisioning_operations_check3 CHECK (((((operation_type)::text = ANY ((ARRAY['init'::character varying, 'import'::character varying])::text[])) AND (NOT is_fork) AND (fork_id IS NULL) AND (source_repository_id IS NULL) AND (source_owner IS NULL) AND (source_repo IS NULL) AND (source_storage_set_id IS NULL)) OR (((operation_type)::text = 'fork'::text) AND is_fork AND (fork_id IS NOT NULL) AND (source_repository_id = fork_id) AND (source_owner IS NOT NULL) AND ((source_owner)::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'::text) AND (source_repo IS NOT NULL) AND (length((source_repo)::text) <= 100) AND ((source_repo)::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'::text) AND (lower((source_repo)::text) !~ '\.(git|wiki|docs)$'::text) AND (source_storage_set_id = storage_set_id)))),
    CONSTRAINT repository_provisioning_operations_check4 CHECK ((((claim_token IS NULL) AND (claimed_at IS NULL)) OR ((claim_token IS NOT NULL) AND (claimed_at IS NOT NULL)))),
    CONSTRAINT repository_provisioning_operations_default_bookmark_check CHECK ((btrim((default_bookmark)::text) <> ''::text)),
    CONSTRAINT repository_provisioning_operations_name_check CHECK (((length((name)::text) <= 100) AND ((name)::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'::text))),
    CONSTRAINT repository_provisioning_operations_name_check1 CHECK ((lower((name)::text) !~ '\.(git|wiki|docs)$'::text)),
    CONSTRAINT repository_provisioning_operations_name_check2 CHECK ((lower((name)::text) <> ALL (ARRAY['agent'::text, 'bookmarks'::text, 'changes'::text, 'commits'::text, 'contributors'::text, 'issues'::text, 'labels'::text, 'landings'::text, 'milestones'::text, 'operations'::text, 'pulls'::text, 'settings'::text, 'stargazers'::text, 'watchers'::text, 'workflows'::text]))),
    CONSTRAINT repository_provisioning_operations_operation_type_check CHECK (((operation_type)::text = ANY ((ARRAY['init'::character varying, 'fork'::character varying, 'import'::character varying])::text[]))),
    CONSTRAINT repository_provisioning_operations_owner_name_check CHECK (((owner_name)::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'::text)),
    CONSTRAINT repository_provisioning_operations_token_check CHECK (((token)::text ~ '^[0-9a-f]{64}$'::text))
);


--

-- Name: runner_pool; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runner_pool (
    id bigint NOT NULL,
    name character varying(255) NOT NULL,
    status character varying(16) NOT NULL,
    last_heartbeat_at timestamptz,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT runner_pool_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT runner_pool_status_check CHECK (((status)::text = ANY ((ARRAY['idle'::character varying, 'busy'::character varying, 'offline'::character varying, 'draining'::character varying])::text[])))
);


--

-- Name: runner_pool_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.runner_pool_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: runner_pool_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.runner_pool_id_seq OWNED BY public.runner_pool.id;


--

-- Name: sandbox_access_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_access_grants (
    id text NOT NULL,
    identity_id text NOT NULL,
    token_hash bytea NOT NULL,
    protocol text DEFAULT 'ssh'::text NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT sandbox_access_grants_protocol_check CHECK ((protocol = ANY (ARRAY['ssh'::text, 'terminal'::text, 'preview'::text])))
);


--

-- Name: sandbox_access_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_access_identities (
    id text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    expires_at timestamptz NOT NULL
);


--

-- Name: sandbox_access_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_access_permissions (
    id text NOT NULL,
    identity_id text NOT NULL,
    sandbox_id text NOT NULL,
    allowed_users text[] DEFAULT '{}'::text[] NOT NULL,
    placement_generation bigint NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT sandbox_access_permissions_placement_generation_check CHECK ((placement_generation > 0))
);


--

-- Name: sandbox_access_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_access_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    vm_id text NOT NULL,
    user_id bigint NOT NULL,
    linux_user text NOT NULL,
    token_hash bytea NOT NULL,
    token_type text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT sandbox_access_tokens_token_type_check CHECK ((token_type = ANY (ARRAY['ssh'::text, 'terminal'::text])))
);


--

-- Name: sandbox_domain_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_domain_mappings (
    domain text NOT NULL,
    sandbox_id text NOT NULL,
    guest_port integer NOT NULL,
    placement_generation bigint NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT sandbox_domain_mappings_guest_port_check CHECK (((guest_port > 0) AND (guest_port <= 65535))),
    CONSTRAINT sandbox_domain_mappings_placement_generation_check CHECK ((placement_generation > 0))
);


--

-- Name: sandbox_egress_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_egress_audit (
    id bigint NOT NULL,
    sandbox_id text NOT NULL,
    resource_kind text NOT NULL,
    resource_id text NOT NULL,
    repository_id bigint,
    occurred_at timestamptz NOT NULL,
    host character varying(253) NOT NULL,
    method character varying(16) NOT NULL,
    path character varying(2048) NOT NULL,
    status integer NOT NULL,
    allowed boolean NOT NULL,
    swapped_secret_names text[] DEFAULT '{}'::text[] NOT NULL,
    transform_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT sandbox_egress_audit_host_check CHECK ((length((host)::text) > 0)),
    CONSTRAINT sandbox_egress_audit_method_check CHECK ((length((method)::text) > 0)),
    CONSTRAINT sandbox_egress_audit_resource_id_check CHECK (((length(resource_id) >= 1) AND (length(resource_id) <= 200))),
    CONSTRAINT sandbox_egress_audit_resource_kind_check CHECK (((length(resource_kind) >= 1) AND (length(resource_kind) <= 64))),
    CONSTRAINT sandbox_egress_audit_status_check CHECK (((status >= 0) AND (status <= 999))),
    CONSTRAINT sandbox_egress_audit_swapped_secret_names_check CHECK ((cardinality(swapped_secret_names) <= 64)),
    CONSTRAINT sandbox_egress_audit_swapped_secret_names_check1 CHECK ((array_position(swapped_secret_names, NULL::text) IS NULL)),
    CONSTRAINT sandbox_egress_audit_transform_summary_check CHECK (((jsonb_typeof(transform_summary) = 'object'::text) AND (pg_column_size(transform_summary) <= 16384)))
);


--

-- Name: sandbox_egress_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sandbox_egress_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: sandbox_egress_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sandbox_egress_audit_id_seq OWNED BY public.sandbox_egress_audit.id;


--

-- Name: sandbox_golden_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_golden_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    snapshot_id text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'baking'::text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT sandbox_golden_snapshots_status_check CHECK ((status = ANY (ARRAY['baking'::text, 'ready'::text, 'failed'::text, 'superseded'::text])))
);


--

-- Name: sandbox_hosts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_hosts (
    id text NOT NULL,
    provider text DEFAULT 'microsandbox'::text NOT NULL,
    identity_public_key bytea NOT NULL,
    identity_signed_at timestamptz NOT NULL,
    base_url text NOT NULL,
    boot_id text DEFAULT ''::text NOT NULL,
    state text DEFAULT 'ready'::text NOT NULL,
    placement_generation bigint DEFAULT 1 NOT NULL,
    capacity_cpu_millis bigint NOT NULL,
    capacity_memory_bytes bigint NOT NULL,
    capacity_disk_bytes bigint NOT NULL,
    capacity_vms integer NOT NULL,
    allocated_cpu_millis bigint DEFAULT 0 NOT NULL,
    allocated_memory_bytes bigint DEFAULT 0 NOT NULL,
    allocated_disk_bytes bigint DEFAULT 0 NOT NULL,
    allocated_vms integer DEFAULT 0 NOT NULL,
    observed_allocated_cpu_millis bigint DEFAULT 0 NOT NULL,
    observed_allocated_memory_bytes bigint DEFAULT 0 NOT NULL,
    observed_allocated_disk_bytes bigint DEFAULT 0 NOT NULL,
    observed_allocated_vms integer DEFAULT 0 NOT NULL,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    runtime_version text DEFAULT ''::text NOT NULL,
    worker_image text DEFAULT ''::text NOT NULL,
    heartbeat_at timestamptz DEFAULT now() NOT NULL,
    lease_expires_at timestamptz NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT sandbox_hosts_allocated_cpu_millis_check CHECK ((allocated_cpu_millis >= 0)),
    CONSTRAINT sandbox_hosts_allocated_disk_bytes_check CHECK ((allocated_disk_bytes >= 0)),
    CONSTRAINT sandbox_hosts_allocated_memory_bytes_check CHECK ((allocated_memory_bytes >= 0)),
    CONSTRAINT sandbox_hosts_allocated_vms_check CHECK ((allocated_vms >= 0)),
    CONSTRAINT sandbox_hosts_capacity_cpu_millis_check CHECK ((capacity_cpu_millis >= 0)),
    CONSTRAINT sandbox_hosts_capacity_disk_bytes_check CHECK ((capacity_disk_bytes >= 0)),
    CONSTRAINT sandbox_hosts_capacity_memory_bytes_check CHECK ((capacity_memory_bytes >= 0)),
    CONSTRAINT sandbox_hosts_capacity_vms_check CHECK ((capacity_vms >= 0)),
    CONSTRAINT sandbox_hosts_identity_public_key_check CHECK ((octet_length(identity_public_key) = 32)),
    CONSTRAINT sandbox_hosts_observed_allocated_cpu_millis_check CHECK ((observed_allocated_cpu_millis >= 0)),
    CONSTRAINT sandbox_hosts_observed_allocated_disk_bytes_check CHECK ((observed_allocated_disk_bytes >= 0)),
    CONSTRAINT sandbox_hosts_observed_allocated_memory_bytes_check CHECK ((observed_allocated_memory_bytes >= 0)),
    CONSTRAINT sandbox_hosts_observed_allocated_vms_check CHECK ((observed_allocated_vms >= 0)),
    CONSTRAINT sandbox_hosts_placement_generation_check CHECK ((placement_generation > 0)),
    CONSTRAINT sandbox_hosts_state_check CHECK ((state = ANY (ARRAY['ready'::text, 'draining'::text, 'stale'::text, 'fenced'::text])))
);


--

-- Name: sandbox_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_instances (
    id text NOT NULL,
    provider text NOT NULL,
    provider_local_id text NOT NULL,
    worker_id text,
    placement_generation bigint DEFAULT 1 NOT NULL,
    desired_state text DEFAULT 'running'::text NOT NULL,
    observed_state text DEFAULT 'starting'::text NOT NULL,
    resource_kind text,
    resource_id text,
    image_ref text DEFAULT ''::text NOT NULL,
    snapshot_id text,
    recovery_snapshot_id text,
    recovery_point_at timestamptz,
    request_spec jsonb DEFAULT '{}'::jsonb NOT NULL,
    recovery_services jsonb DEFAULT '[]'::jsonb NOT NULL,
    requested_cpu_millis bigint DEFAULT 1000 NOT NULL,
    requested_memory_bytes bigint DEFAULT 0 NOT NULL,
    requested_disk_bytes bigint DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires_at timestamptz,
    last_heartbeat_at timestamptz,
    compute_observed_at timestamptz,
    cleanup_pending boolean DEFAULT false NOT NULL,
    reservation_held boolean DEFAULT true NOT NULL,
    recovery_reason text DEFAULT ''::text NOT NULL,
    last_error text DEFAULT ''::text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    deleted_at timestamptz,
    CONSTRAINT sandbox_instances_desired_state_check CHECK ((desired_state = ANY (ARRAY['created'::text, 'running'::text, 'stopped'::text, 'deleted'::text]))),
    CONSTRAINT sandbox_instances_observed_state_check CHECK ((observed_state = ANY (ARRAY['created'::text, 'starting'::text, 'running'::text, 'stopping'::text, 'stopped'::text, 'restart_pending'::text, 'recovering'::text, 'deleting'::text, 'degraded'::text, 'failed'::text, 'deleted'::text]))),
    CONSTRAINT sandbox_instances_placement_generation_check CHECK ((placement_generation > 0)),
    CONSTRAINT sandbox_instances_recovery_reason_check CHECK ((recovery_reason = ANY (ARRAY[''::text, 'worker_lost'::text, 'planned_drain'::text, 'secrets_required'::text]))),
    CONSTRAINT sandbox_instances_recovery_services_check CHECK ((jsonb_typeof(recovery_services) = 'array'::text)),
    CONSTRAINT sandbox_instances_requested_cpu_millis_check CHECK ((requested_cpu_millis >= 0)),
    CONSTRAINT sandbox_instances_requested_disk_bytes_check CHECK ((requested_disk_bytes >= 0)),
    CONSTRAINT sandbox_instances_requested_memory_bytes_check CHECK ((requested_memory_bytes >= 0))
);


--

-- Name: sandbox_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_operations (
    idempotency_key text NOT NULL,
    sandbox_id text,
    operation text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    request_digest text NOT NULL,
    response jsonb,
    error_code text DEFAULT ''::text NOT NULL,
    lease_expires_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT sandbox_operations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text])))
);


--

-- Name: sandbox_orphans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_orphans (
    worker_id text NOT NULL,
    provider_local_id text NOT NULL,
    placement_generation bigint NOT NULL,
    first_seen_at timestamptz DEFAULT now() NOT NULL,
    last_seen_at timestamptz DEFAULT now() NOT NULL,
    delete_after timestamptz NOT NULL,
    CONSTRAINT sandbox_orphans_placement_generation_check CHECK ((placement_generation > 0))
);


--

-- Name: sandbox_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_snapshots (
    id text NOT NULL,
    provider text NOT NULL,
    provider_local_id text NOT NULL,
    source_sandbox_id text,
    worker_id text,
    placement_generation bigint NOT NULL,
    state text DEFAULT 'creating'::text NOT NULL,
    scope text DEFAULT 'disk'::text NOT NULL,
    object_uri text,
    digest text,
    size_bytes bigint,
    cleanup_owner text,
    cleanup_lease_expires_at timestamptz,
    garbage_collectible boolean DEFAULT false NOT NULL,
    last_error text DEFAULT ''::text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    deleted_at timestamptz,
    CONSTRAINT sandbox_snapshots_placement_generation_check CHECK ((placement_generation > 0)),
    CONSTRAINT sandbox_snapshots_scope_check CHECK ((scope = 'disk'::text)),
    CONSTRAINT sandbox_snapshots_state_check CHECK ((state = ANY (ARRAY['creating'::text, 'ready'::text, 'exporting'::text, 'exported'::text, 'failed'::text, 'deleting'::text, 'deleted'::text])))
);


--

-- Name: sandbox_volumes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_volumes (
    id text NOT NULL,
    provider text NOT NULL,
    provider_local_id text NOT NULL,
    worker_id text,
    placement_generation bigint DEFAULT 1 NOT NULL,
    state text DEFAULT 'created'::text NOT NULL,
    quota_bytes bigint,
    object_uri text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    deleted_at timestamptz,
    CONSTRAINT sandbox_volumes_placement_generation_check CHECK ((placement_generation > 0)),
    CONSTRAINT sandbox_volumes_quota_bytes_check CHECK (((quota_bytes IS NULL) OR (quota_bytes >= 0)))
);


--

-- Name: storage_deletion_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_deletion_queue (
    id bigint NOT NULL,
    repository_id bigint NOT NULL,
    owner_type character varying(16) NOT NULL,
    owner_id bigint NOT NULL,
    allocation_key text NOT NULL,
    object_key text NOT NULL,
    size_bytes bigint NOT NULL,
    delete_after timestamptz NOT NULL,
    requested_delete_after timestamptz,
    claim_token character varying(64),
    claimed_at timestamptz,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT storage_deletion_queue_allocation_key_check CHECK ((btrim(allocation_key) <> ''::text)),
    CONSTRAINT storage_deletion_queue_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT storage_deletion_queue_claim_state_check CHECK ((((claim_token IS NULL) AND (claimed_at IS NULL)) OR ((claim_token IS NOT NULL) AND (claimed_at IS NOT NULL)))),
    CONSTRAINT storage_deletion_queue_object_key_check CHECK ((btrim(object_key) <> ''::text)),
    CONSTRAINT storage_deletion_queue_owner_type_check CHECK (((owner_type)::text = ANY ((ARRAY['user'::character varying, 'org'::character varying])::text[]))),
    CONSTRAINT storage_deletion_queue_size_bytes_check CHECK ((size_bytes >= 0))
);


--

-- Name: storage_deletion_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.storage_deletion_queue_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: storage_deletion_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.storage_deletion_queue_id_seq OWNED BY public.storage_deletion_queue.id;


--

-- Name: storage_legacy_capability_horizons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_legacy_capability_horizons (
    capability_kind character varying(64) NOT NULL,
    valid_until timestamptz NOT NULL,
    attested_at timestamptz,
    attested_by text,
    attestation text,
    CONSTRAINT storage_legacy_capability_horizons_attestation_check CHECK ((((valid_until = 'infinity'::timestamptz) AND (attested_at IS NULL) AND (attested_by IS NULL) AND (attestation IS NULL)) OR (isfinite(valid_until) AND (attested_at IS NOT NULL) AND (btrim(COALESCE(attested_by, ''::text)) <> ''::text) AND (btrim(COALESCE(attestation, ''::text)) <> ''::text))))
);


--

-- Name: workflow_run_coding_hosts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_run_coding_hosts (
    workflow_run_id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    host_run_id text NOT NULL,
    flow_id text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT workflow_run_coding_hosts_flow_id_present CHECK ((flow_id <> ''::text)),
    CONSTRAINT workflow_run_coding_hosts_host_run_id_present CHECK ((host_run_id <> ''::text))
);


--

-- Name: workflow_sandbox_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_sandbox_claims (
    workflow_run_id bigint NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    claim_token uuid,
    claimed_at timestamptz,
    lease_expires_at timestamptz,
    CONSTRAINT workflow_sandbox_claims_active_fields_match CHECK ((((claim_token IS NULL) AND (claimed_at IS NULL) AND (lease_expires_at IS NULL)) OR ((claim_token IS NOT NULL) AND (claimed_at IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT workflow_sandbox_claims_generation_nonnegative CHECK ((generation >= 0))
);


--

-- Name: alert_incidents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_incidents ALTER COLUMN id SET DEFAULT nextval('public.alert_incidents_id_seq'::regclass);


--

-- Name: alert_remediation_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_remediation_jobs ALTER COLUMN id SET DEFAULT nextval('public.alert_remediation_jobs_id_seq'::regclass);


--

-- Name: canary_results id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canary_results ALTER COLUMN id SET DEFAULT nextval('public.canary_results_id_seq'::regclass);


--

-- Name: github_proxy_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_proxy_audit_log ALTER COLUMN id SET DEFAULT nextval('public.github_proxy_audit_log_id_seq'::regclass);


--

-- Name: memory_cleanup_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_cleanup_tasks ALTER COLUMN id SET DEFAULT nextval('public.memory_cleanup_tasks_id_seq'::regclass);


--

-- Name: memory_ingest_batches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_ingest_batches ALTER COLUMN id SET DEFAULT nextval('public.memory_ingest_batches_id_seq'::regclass);


--

-- Name: memory_promotion_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_promotion_tasks ALTER COLUMN id SET DEFAULT nextval('public.memory_promotion_tasks_id_seq'::regclass);


--

-- Name: memory_provisioning_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_provisioning_tasks ALTER COLUMN id SET DEFAULT nextval('public.memory_provisioning_tasks_id_seq'::regclass);


--

-- Name: memory_write_freezes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_write_freezes ALTER COLUMN id SET DEFAULT nextval('public.memory_write_freezes_id_seq'::regclass);


--

-- Name: repo_replication_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_replication_jobs ALTER COLUMN id SET DEFAULT nextval('public.repo_replication_jobs_id_seq'::regclass);


--

-- Name: runner_pool id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_pool ALTER COLUMN id SET DEFAULT nextval('public.runner_pool_id_seq'::regclass);


--

-- Name: sandbox_egress_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_egress_audit ALTER COLUMN id SET DEFAULT nextval('public.sandbox_egress_audit_id_seq'::regclass);


--

-- Name: storage_deletion_queue id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_deletion_queue ALTER COLUMN id SET DEFAULT nextval('public.storage_deletion_queue_id_seq'::regclass);


--

-- Name: _id_remap _id_remap_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._id_remap
    ADD CONSTRAINT _id_remap_pkey PRIMARY KEY (local_id);


--

-- Name: _sync_queue _sync_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._sync_queue
    ADD CONSTRAINT _sync_queue_pkey PRIMARY KEY (id);


--

-- Name: alert_incident_deliveries alert_incident_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_incident_deliveries
    ADD CONSTRAINT alert_incident_deliveries_pkey PRIMARY KEY (incident_id);


--

-- Name: alert_incidents alert_incidents_incident_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_incidents
    ADD CONSTRAINT alert_incidents_incident_id_key UNIQUE (incident_id);


--

-- Name: alert_incidents alert_incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_incidents
    ADD CONSTRAINT alert_incidents_pkey PRIMARY KEY (id);


--

-- Name: alert_remediation_jobs alert_remediation_jobs_dispatch_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_remediation_jobs
    ADD CONSTRAINT alert_remediation_jobs_dispatch_token_key UNIQUE (dispatch_token);


--

-- Name: alert_remediation_jobs alert_remediation_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_remediation_jobs
    ADD CONSTRAINT alert_remediation_jobs_pkey PRIMARY KEY (id);


--

-- Name: canary_results canary_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canary_results
    ADD CONSTRAINT canary_results_pkey PRIMARY KEY (id);


--

-- Name: canary_results canary_results_suite_test_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canary_results
    ADD CONSTRAINT canary_results_suite_test_name_key UNIQUE (suite, test_name);


--

-- Name: github_proxy_audit_log github_proxy_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_proxy_audit_log
    ADD CONSTRAINT github_proxy_audit_log_pkey PRIMARY KEY (id);


--

-- Name: legacy_mutation_fence_control legacy_mutation_fence_control_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legacy_mutation_fence_control
    ADD CONSTRAINT legacy_mutation_fence_control_pkey PRIMARY KEY (singleton);


--

-- Name: memory_cleanup_items memory_cleanup_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_cleanup_items
    ADD CONSTRAINT memory_cleanup_items_pkey PRIMARY KEY (cleanup_task_id, memory_id);


--

-- Name: memory_cleanup_tasks memory_cleanup_tasks_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_cleanup_tasks
    ADD CONSTRAINT memory_cleanup_tasks_idempotency_key_key UNIQUE (idempotency_key);


--

-- Name: memory_cleanup_tasks memory_cleanup_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_cleanup_tasks
    ADD CONSTRAINT memory_cleanup_tasks_pkey PRIMARY KEY (id);


--

-- Name: memory_ingest_batches memory_ingest_batches_document_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_ingest_batches
    ADD CONSTRAINT memory_ingest_batches_document_id_key UNIQUE (document_id);


--

-- Name: memory_ingest_batches memory_ingest_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_ingest_batches
    ADD CONSTRAINT memory_ingest_batches_pkey PRIMARY KEY (id);


--

-- Name: memory_ingest_batches memory_ingest_batches_session_id_from_message_sequence_thro_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_ingest_batches
    ADD CONSTRAINT memory_ingest_batches_session_id_from_message_sequence_thro_key UNIQUE (session_id, from_message_sequence, through_message_sequence);


--

-- Name: memory_ingest_cursors memory_ingest_cursors_document_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_ingest_cursors
    ADD CONSTRAINT memory_ingest_cursors_document_id_key UNIQUE (document_id);


--

-- Name: memory_ingest_cursors memory_ingest_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_ingest_cursors
    ADD CONSTRAINT memory_ingest_cursors_pkey PRIMARY KEY (session_id);


--

-- Name: memory_maintenance_cursors memory_maintenance_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_maintenance_cursors
    ADD CONSTRAINT memory_maintenance_cursors_pkey PRIMARY KEY (maintenance_kind);


--

-- Name: memory_promotion_items memory_promotion_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_promotion_items
    ADD CONSTRAINT memory_promotion_items_pkey PRIMARY KEY (promotion_task_id, memory_id);


--

-- Name: memory_promotion_tasks memory_promotion_tasks_landing_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_promotion_tasks
    ADD CONSTRAINT memory_promotion_tasks_landing_request_id_key UNIQUE (landing_request_id);


--

-- Name: memory_promotion_tasks memory_promotion_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_promotion_tasks
    ADD CONSTRAINT memory_promotion_tasks_pkey PRIMARY KEY (id);


--

-- Name: memory_provisioning_tasks memory_provisioning_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_provisioning_tasks
    ADD CONSTRAINT memory_provisioning_tasks_pkey PRIMARY KEY (id);


--

-- Name: memory_provisioning_tasks memory_provisioning_tasks_target_kind_target_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_provisioning_tasks
    ADD CONSTRAINT memory_provisioning_tasks_target_kind_target_id_key UNIQUE (target_kind, target_id);


--

-- Name: memory_restore_manifests memory_restore_manifests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_restore_manifests
    ADD CONSTRAINT memory_restore_manifests_pkey PRIMARY KEY (restore_id);


--

-- Name: memory_write_freezes memory_write_freezes_lease_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_write_freezes
    ADD CONSTRAINT memory_write_freezes_lease_token_key UNIQUE (lease_token);


--

-- Name: memory_write_freezes memory_write_freezes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_write_freezes
    ADD CONSTRAINT memory_write_freezes_pkey PRIMARY KEY (id);


--

-- Name: repo_gateways repo_gateways_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_gateways
    ADD CONSTRAINT repo_gateways_pkey PRIMARY KEY (id);


--

-- Name: repo_replicas repo_replicas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_replicas
    ADD CONSTRAINT repo_replicas_pkey PRIMARY KEY (repository_id, node_id);


--

-- Name: repo_replication_jobs repo_replication_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_replication_jobs
    ADD CONSTRAINT repo_replication_jobs_pkey PRIMARY KEY (id);


--

-- Name: repo_storage_nodes repo_storage_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_storage_nodes
    ADD CONSTRAINT repo_storage_nodes_pkey PRIMARY KEY (id);


--

-- Name: repo_storage_nodes repo_storage_nodes_storage_set_id_url_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_storage_nodes
    ADD CONSTRAINT repo_storage_nodes_storage_set_id_url_key UNIQUE (storage_set_id, url);


--

-- Name: repo_storage_sets repo_storage_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_storage_sets
    ADD CONSTRAINT repo_storage_sets_pkey PRIMARY KEY (id);


--

-- Name: repo_write_locks repo_write_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_write_locks
    ADD CONSTRAINT repo_write_locks_pkey PRIMARY KEY (repository_id);


--

-- Name: repository_provisioning_control repository_provisioning_control_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_provisioning_control
    ADD CONSTRAINT repository_provisioning_control_pkey PRIMARY KEY (singleton);


--

-- Name: repository_provisioning_operations repository_provisioning_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_provisioning_operations
    ADD CONSTRAINT repository_provisioning_operations_pkey PRIMARY KEY (repository_id);


--

-- Name: repository_provisioning_operations repository_provisioning_operations_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_provisioning_operations
    ADD CONSTRAINT repository_provisioning_operations_token_key UNIQUE (token);


--

-- Name: runner_pool runner_pool_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_pool
    ADD CONSTRAINT runner_pool_name_key UNIQUE (name);


--

-- Name: runner_pool runner_pool_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_pool
    ADD CONSTRAINT runner_pool_pkey PRIMARY KEY (id);


--

-- Name: sandbox_access_grants sandbox_access_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_access_grants
    ADD CONSTRAINT sandbox_access_grants_pkey PRIMARY KEY (id);


--

-- Name: sandbox_access_grants sandbox_access_grants_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_access_grants
    ADD CONSTRAINT sandbox_access_grants_token_hash_key UNIQUE (token_hash);


--

-- Name: sandbox_access_identities sandbox_access_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_access_identities
    ADD CONSTRAINT sandbox_access_identities_pkey PRIMARY KEY (id);


--

-- Name: sandbox_access_permissions sandbox_access_permissions_identity_id_sandbox_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_access_permissions
    ADD CONSTRAINT sandbox_access_permissions_identity_id_sandbox_id_key UNIQUE (identity_id, sandbox_id);


--

-- Name: sandbox_access_permissions sandbox_access_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_access_permissions
    ADD CONSTRAINT sandbox_access_permissions_pkey PRIMARY KEY (id);


--

-- Name: sandbox_access_tokens sandbox_access_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_access_tokens
    ADD CONSTRAINT sandbox_access_tokens_pkey PRIMARY KEY (id);


--

-- Name: sandbox_domain_mappings sandbox_domain_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_domain_mappings
    ADD CONSTRAINT sandbox_domain_mappings_pkey PRIMARY KEY (domain);


--

-- Name: sandbox_egress_audit sandbox_egress_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_egress_audit
    ADD CONSTRAINT sandbox_egress_audit_pkey PRIMARY KEY (id);


--

-- Name: sandbox_environment_images sandbox_environment_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_environment_images
    ADD CONSTRAINT sandbox_environment_images_pkey PRIMARY KEY (id);


--

-- Name: sandbox_golden_snapshots sandbox_golden_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_golden_snapshots
    ADD CONSTRAINT sandbox_golden_snapshots_pkey PRIMARY KEY (id);


--

-- Name: sandbox_hosts sandbox_hosts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_hosts
    ADD CONSTRAINT sandbox_hosts_pkey PRIMARY KEY (id);


--

-- Name: sandbox_instances sandbox_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_instances
    ADD CONSTRAINT sandbox_instances_pkey PRIMARY KEY (id);


--

-- Name: sandbox_instances sandbox_instances_provider_provider_local_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_instances
    ADD CONSTRAINT sandbox_instances_provider_provider_local_id_key UNIQUE (provider, provider_local_id);


--

-- Name: sandbox_operations sandbox_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_operations
    ADD CONSTRAINT sandbox_operations_pkey PRIMARY KEY (idempotency_key);


--

-- Name: sandbox_orphans sandbox_orphans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_orphans
    ADD CONSTRAINT sandbox_orphans_pkey PRIMARY KEY (worker_id, provider_local_id, placement_generation);


--

-- Name: sandbox_snapshots sandbox_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_snapshots
    ADD CONSTRAINT sandbox_snapshots_pkey PRIMARY KEY (id);


--

-- Name: sandbox_snapshots sandbox_snapshots_provider_provider_local_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_snapshots
    ADD CONSTRAINT sandbox_snapshots_provider_provider_local_id_key UNIQUE (provider, provider_local_id);


--

-- Name: sandbox_volumes sandbox_volumes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_volumes
    ADD CONSTRAINT sandbox_volumes_pkey PRIMARY KEY (id);


--

-- Name: sandbox_volumes sandbox_volumes_provider_provider_local_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_volumes
    ADD CONSTRAINT sandbox_volumes_provider_provider_local_id_key UNIQUE (provider, provider_local_id);


--

-- Name: storage_deletion_queue storage_deletion_queue_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_deletion_queue
    ADD CONSTRAINT storage_deletion_queue_object_key_key UNIQUE (object_key);


--

-- Name: storage_deletion_queue storage_deletion_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_deletion_queue
    ADD CONSTRAINT storage_deletion_queue_pkey PRIMARY KEY (id);


--

-- Name: storage_legacy_capability_horizons storage_legacy_capability_horizons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_legacy_capability_horizons
    ADD CONSTRAINT storage_legacy_capability_horizons_pkey PRIMARY KEY (capability_kind);


--

-- Name: workflow_run_coding_hosts workflow_run_coding_hosts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_run_coding_hosts
    ADD CONSTRAINT workflow_run_coding_hosts_pkey PRIMARY KEY (workflow_run_id);


--

-- Name: workflow_sandbox_claims workflow_sandbox_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_sandbox_claims
    ADD CONSTRAINT workflow_sandbox_claims_pkey PRIMARY KEY (workflow_run_id);


--

-- Name: idx_alert_incident_deliveries_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_incident_deliveries_live ON public.alert_incident_deliveries USING btree (canonical_incident_id) WHERE (closed_at IS NULL);


--

-- Name: idx_alert_incidents_policy_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_incidents_policy_active ON public.alert_incidents USING btree (policy_name) WHERE (state = ANY (ARRAY['open'::text, 'remediating'::text, 'pr_opened'::text]));


--

-- Name: idx_alert_incidents_policy_condition_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_incidents_policy_condition_active ON public.alert_incidents USING btree (policy_name, condition_name, id) WHERE (state = ANY (ARRAY['open'::text, 'remediating'::text, 'pr_opened'::text]));


--

-- Name: idx_alert_incidents_policy_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_incidents_policy_created ON public.alert_incidents USING btree (policy_name, created_at DESC);


--

-- Name: idx_alert_remediation_jobs_incident; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_remediation_jobs_incident ON public.alert_remediation_jobs USING btree (incident_id, created_at DESC);


--

-- Name: idx_alert_remediation_jobs_pending_dequeue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_remediation_jobs_pending_dequeue ON public.alert_remediation_jobs USING btree (available_at, id) WHERE ((status)::text = 'pending'::text);


--

-- Name: idx_alert_remediation_jobs_workflow_run; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_alert_remediation_jobs_workflow_run ON public.alert_remediation_jobs USING btree (workflow_run_id) WHERE (workflow_run_id IS NOT NULL);


--

-- Name: idx_canary_results_suite_reported; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_canary_results_suite_reported ON public.canary_results USING btree (suite, reported_at DESC);


--

-- Name: idx_github_proxy_audit_log_workflow_run_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_github_proxy_audit_log_workflow_run_created ON public.github_proxy_audit_log USING btree (workflow_run_id, created_at DESC);


--

-- Name: idx_id_remap_remote_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_id_remap_remote_id ON public._id_remap USING btree (remote_id) WHERE (remote_id IS NOT NULL);


--

-- Name: idx_id_remap_resource_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_id_remap_resource_type ON public._id_remap USING btree (resource_type);


--

-- Name: idx_memory_cleanup_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_cleanup_claim ON public.memory_cleanup_tasks USING btree (available_at, created_at, id) WHERE ((status)::text = 'pending'::text);


--

-- Name: idx_memory_cleanup_stale; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_cleanup_stale ON public.memory_cleanup_tasks USING btree (lease_expires_at) WHERE ((status)::text = 'running'::text);


--

-- Name: idx_memory_cleanup_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_cleanup_target ON public.memory_cleanup_tasks USING btree (task_kind, target_id, created_at DESC);


--

-- Name: idx_memory_ingest_batches_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_ingest_batches_pending ON public.memory_ingest_batches USING btree (status, created_at, id) WHERE ((status)::text <> 'cursor_advanced'::text);


--

-- Name: idx_memory_promotion_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_promotion_claim ON public.memory_promotion_tasks USING btree (available_at, created_at, id) WHERE ((status)::text = 'pending'::text);


--

-- Name: idx_memory_promotion_stale; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_promotion_stale ON public.memory_promotion_tasks USING btree (lease_expires_at) WHERE ((status)::text = 'running'::text);


--

-- Name: idx_memory_provisioning_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_provisioning_claim ON public.memory_provisioning_tasks USING btree (available_at, created_at, id) WHERE ((status)::text = 'pending'::text);


--

-- Name: idx_memory_provisioning_stale; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_provisioning_stale ON public.memory_provisioning_tasks USING btree (lease_expires_at) WHERE ((status)::text = 'running'::text);


--

-- Name: idx_memory_write_freezes_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_write_freezes_expiry ON public.memory_write_freezes USING btree (expires_at) WHERE (released_at IS NULL);


--

-- Name: idx_repo_gateways_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repo_gateways_status ON public.repo_gateways USING btree (status) WHERE (deleted_at IS NULL);


--

-- Name: idx_repo_replicas_node_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repo_replicas_node_state ON public.repo_replicas USING btree (node_id, state);


--

-- Name: idx_repo_replicas_repository_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repo_replicas_repository_state ON public.repo_replicas USING btree (repository_id, state, generation DESC);


--

-- Name: idx_repo_replication_jobs_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repo_replication_jobs_claim ON public.repo_replication_jobs USING btree (state, run_after, id);


--

-- Name: idx_repo_replication_jobs_repository; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repo_replication_jobs_repository ON public.repo_replication_jobs USING btree (repository_id, generation DESC);


--

-- Name: idx_repo_storage_nodes_storage_set; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repo_storage_nodes_storage_set ON public.repo_storage_nodes USING btree (storage_set_id, state);


--

-- Name: idx_repo_write_locks_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repo_write_locks_expires_at ON public.repo_write_locks USING btree (expires_at);


--

-- Name: idx_repository_provisioning_reconcile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repository_provisioning_reconcile ON public.repository_provisioning_operations USING btree (publish_ready, created_at, claimed_at, repository_id);


--

-- Name: idx_repository_provisioning_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repository_provisioning_source ON public.repository_provisioning_operations USING btree (source_repository_id) WHERE (source_repository_id IS NOT NULL);


--

-- Name: idx_runner_pool_metadata_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runner_pool_metadata_gin ON public.runner_pool USING gin (metadata);


--

-- Name: idx_runner_pool_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runner_pool_status ON public.runner_pool USING btree (status);


--

-- Name: idx_sandbox_access_tokens_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sandbox_access_tokens_expires_at ON public.sandbox_access_tokens USING btree (expires_at);


--

-- Name: idx_sandbox_access_tokens_vm_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sandbox_access_tokens_vm_id ON public.sandbox_access_tokens USING btree (vm_id);


--

-- Name: idx_storage_deletion_queue_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storage_deletion_queue_due ON public.storage_deletion_queue USING btree (delete_after, claimed_at, id);


--

-- Name: idx_storage_deletion_queue_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storage_deletion_queue_owner ON public.storage_deletion_queue USING btree (owner_type, owner_id, allocation_key);


--

-- Name: idx_storage_deletion_queue_repository; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storage_deletion_queue_repository ON public.storage_deletion_queue USING btree (repository_id, allocation_key);


--

-- Name: idx_sync_queue_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_queue_status ON public._sync_queue USING btree (status, created_at);


--

-- Name: idx_workflow_run_coding_hosts_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_run_coding_hosts_workspace ON public.workflow_run_coding_hosts USING btree (workspace_id, workflow_run_id);


--

-- Name: idx_workflow_sandbox_claims_active_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_workflow_sandbox_claims_active_token ON public.workflow_sandbox_claims USING btree (claim_token) WHERE (claim_token IS NOT NULL);


--

-- Name: idx_workflow_sandbox_claims_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_sandbox_claims_expiry ON public.workflow_sandbox_claims USING btree (lease_expires_at, workflow_run_id) WHERE (claim_token IS NOT NULL);


--

-- Name: sandbox_access_grants_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_access_grants_expiry_idx ON public.sandbox_access_grants USING btree (expires_at) WHERE (revoked_at IS NULL);


--

-- Name: sandbox_access_permissions_sandbox_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_access_permissions_sandbox_idx ON public.sandbox_access_permissions USING btree (sandbox_id, identity_id);


--

-- Name: sandbox_egress_audit_repository_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_egress_audit_repository_occurred_idx ON public.sandbox_egress_audit USING btree (repository_id, occurred_at DESC);


--

-- Name: sandbox_egress_audit_resource_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_egress_audit_resource_occurred_idx ON public.sandbox_egress_audit USING btree (resource_kind, resource_id, occurred_at DESC);


--

-- Name: sandbox_environment_images_closure; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sandbox_environment_images_closure ON public.sandbox_environment_images USING btree (COALESCE(repository_id, (0)::bigint), kind, closure_hash);


--

-- Name: sandbox_environment_images_one_ready_base; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sandbox_environment_images_one_ready_base ON public.sandbox_environment_images USING btree (kind) WHERE ((repository_id IS NULL) AND (status = 'ready'::text));


--

-- Name: sandbox_environment_images_ready; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_environment_images_ready ON public.sandbox_environment_images USING btree (COALESCE(repository_id, (0)::bigint), kind, created_at DESC) WHERE (status = 'ready'::text);


--

-- Name: sandbox_golden_snapshots_one_baking; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sandbox_golden_snapshots_one_baking ON public.sandbox_golden_snapshots USING btree (kind) WHERE (status = 'baking'::text);


--

-- Name: sandbox_golden_snapshots_ready; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_golden_snapshots_ready ON public.sandbox_golden_snapshots USING btree (kind, created_at DESC) WHERE (status = 'ready'::text);


--

-- Name: sandbox_hosts_schedulable_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_hosts_schedulable_idx ON public.sandbox_hosts USING btree (state, lease_expires_at, allocated_vms, heartbeat_at);


--

-- Name: sandbox_instances_resource_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_instances_resource_idx ON public.sandbox_instances USING btree (resource_kind, resource_id) WHERE (deleted_at IS NULL);


--

-- Name: sandbox_instances_worker_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_instances_worker_state_idx ON public.sandbox_instances USING btree (worker_id, observed_state) WHERE (deleted_at IS NULL);


--

-- Name: sandbox_operations_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_operations_expiry_idx ON public.sandbox_operations USING btree (expires_at);


--

-- Name: sandbox_orphans_delete_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_orphans_delete_idx ON public.sandbox_orphans USING btree (worker_id, delete_after);


--

-- Name: sandbox_snapshots_cleanup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_snapshots_cleanup_idx ON public.sandbox_snapshots USING btree (state, updated_at, cleanup_lease_expires_at) WHERE (deleted_at IS NULL);


--

-- Name: uq_memory_write_freezes_active_target; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_memory_write_freezes_active_target ON public.memory_write_freezes USING btree (target_kind, COALESCE(target_id, (0)::bigint)) WHERE (released_at IS NULL);


--

-- Name: uq_repo_gateways_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_repo_gateways_active ON public.repo_gateways USING btree (repository_id, user_id, COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE ((deleted_at IS NULL) AND ((status)::text = ANY ((ARRAY['starting'::character varying, 'running'::character varying, 'suspended'::character varying])::text[])));


--

-- Name: uq_repository_provisioning_org_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_repository_provisioning_org_name ON public.repository_provisioning_operations USING btree (org_id, lower_name) WHERE (org_id IS NOT NULL);


--

-- Name: uq_repository_provisioning_user_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_repository_provisioning_user_name ON public.repository_provisioning_operations USING btree (user_id, lower_name) WHERE (user_id IS NOT NULL);


--

-- Name: alert_incidents trg_alert_incidents_terminal_state_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_alert_incidents_terminal_state_guard BEFORE UPDATE OF state ON public.alert_incidents FOR EACH ROW EXECUTE FUNCTION public.guard_alert_incident_terminal_state();


--

-- Name: issue_artifacts trg_issue_artifacts_enqueue_storage_deletion; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_issue_artifacts_enqueue_storage_deletion BEFORE DELETE ON public.issue_artifacts FOR EACH ROW EXECUTE FUNCTION public.enqueue_issue_artifact_storage_deletion();


--

-- Name: lfs_objects trg_lfs_objects_enqueue_storage_deletion; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_lfs_objects_enqueue_storage_deletion BEFORE DELETE OR UPDATE OF repository_id, oid, gcs_path ON public.lfs_objects FOR EACH ROW EXECUTE FUNCTION public.enqueue_lfs_object_storage_deletion();


--

-- Name: lfs_objects trg_lfs_objects_resolve_recreated_storage_keys; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_lfs_objects_resolve_recreated_storage_keys BEFORE INSERT OR UPDATE OF repository_id, oid, gcs_path ON public.lfs_objects FOR EACH ROW EXECUTE FUNCTION public.resolve_recreated_lfs_storage_keys();


--

-- Name: lfs_upload_reservations trg_lfs_reservations_enqueue_storage_deletion; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_lfs_reservations_enqueue_storage_deletion BEFORE DELETE OR UPDATE OF repository_id, oid ON public.lfs_upload_reservations FOR EACH ROW EXECUTE FUNCTION public.enqueue_lfs_reservation_storage_deletion();


--

-- Name: lfs_upload_reservations trg_lfs_reservations_resolve_recreated_storage_keys; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_lfs_reservations_resolve_recreated_storage_keys BEFORE INSERT OR UPDATE OF repository_id, oid ON public.lfs_upload_reservations FOR EACH ROW EXECUTE FUNCTION public.resolve_recreated_lfs_storage_keys();


--

-- Name: release_assets trg_release_assets_enqueue_storage_deletion; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_release_assets_enqueue_storage_deletion BEFORE DELETE ON public.release_assets FOR EACH ROW EXECUTE FUNCTION public.enqueue_release_asset_storage_deletion();


--

-- Name: releases trg_releases_enqueue_storage_deletions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_releases_enqueue_storage_deletions BEFORE DELETE ON public.releases FOR EACH ROW EXECUTE FUNCTION public.enqueue_release_storage_deletions();


--

-- Name: repo_gateways trg_repo_gateways_private_execution; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_repo_gateways_private_execution BEFORE INSERT OR UPDATE OF workspace_id, status, deleted_at ON public.repo_gateways FOR EACH ROW EXECUTE FUNCTION public.guard_workspace_gateway_sharing();


--

-- Name: repositories trg_repositories_enqueue_storage_deletions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_repositories_enqueue_storage_deletions BEFORE DELETE ON public.repositories FOR EACH ROW EXECUTE FUNCTION public.enqueue_repository_storage_deletions();


--

-- Name: repositories trg_repositories_retarget_storage_deletions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_repositories_retarget_storage_deletions AFTER UPDATE OF user_id, org_id ON public.repositories FOR EACH ROW WHEN (((old.user_id IS DISTINCT FROM new.user_id) OR (old.org_id IS DISTINCT FROM new.org_id))) EXECUTE FUNCTION public.retarget_repository_storage_deletions();


--

-- Name: repository_provisioning_operations trg_repository_provisioning_validate_identity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_repository_provisioning_validate_identity BEFORE INSERT OR UPDATE ON public.repository_provisioning_operations FOR EACH ROW EXECUTE FUNCTION public.validate_repository_provisioning_operation();


--

-- Name: storage_legacy_capability_horizons trg_storage_legacy_capability_horizon_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_storage_legacy_capability_horizon_guard BEFORE DELETE OR UPDATE ON public.storage_legacy_capability_horizons FOR EACH ROW EXECUTE FUNCTION public.guard_storage_legacy_capability_horizon();


--

-- Name: workflow_artifacts trg_workflow_artifacts_enqueue_storage_deletion; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_workflow_artifacts_enqueue_storage_deletion BEFORE DELETE ON public.workflow_artifacts FOR EACH ROW EXECUTE FUNCTION public.enqueue_workflow_artifact_storage_deletion();


--

-- Name: workflow_caches trg_workflow_caches_enqueue_storage_deletion; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_workflow_caches_enqueue_storage_deletion BEFORE DELETE OR UPDATE OF object_key ON public.workflow_caches FOR EACH ROW EXECUTE FUNCTION public.enqueue_workflow_cache_storage_deletion();


--

-- Name: workflow_runs trg_workflow_runs_40_sandbox_terminal_claim_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_workflow_runs_40_sandbox_terminal_claim_guard BEFORE UPDATE OF status ON public.workflow_runs FOR EACH ROW EXECUTE FUNCTION public.guard_workflow_sandbox_terminal_claim();


--

-- Name: workflow_runs trg_workflow_runs_90_invalidate_sandbox_claim; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_workflow_runs_90_invalidate_sandbox_claim AFTER UPDATE OF status ON public.workflow_runs FOR EACH ROW EXECUTE FUNCTION public.invalidate_workflow_sandbox_claim();


--

-- Name: workspace_shares trg_workspace_shares_private_execution; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_workspace_shares_private_execution BEFORE INSERT OR UPDATE OF workspace_id, level ON public.workspace_shares FOR EACH ROW EXECUTE FUNCTION public.guard_workspace_gateway_sharing();


--

-- Name: alert_incident_deliveries alert_incident_deliveries_canonical_incident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_incident_deliveries
    ADD CONSTRAINT alert_incident_deliveries_canonical_incident_id_fkey FOREIGN KEY (canonical_incident_id) REFERENCES public.alert_incidents(id) ON DELETE CASCADE;


--

-- Name: alert_remediation_jobs alert_remediation_jobs_incident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_remediation_jobs
    ADD CONSTRAINT alert_remediation_jobs_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES public.alert_incidents(id) ON DELETE CASCADE;


--

-- Name: alert_remediation_jobs alert_remediation_jobs_workflow_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_remediation_jobs
    ADD CONSTRAINT alert_remediation_jobs_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES public.workflow_runs(id) ON DELETE SET NULL;


--

-- Name: github_proxy_audit_log github_proxy_audit_log_workflow_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_proxy_audit_log
    ADD CONSTRAINT github_proxy_audit_log_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES public.workflow_runs(id) ON DELETE CASCADE;


--

-- Name: memory_cleanup_items memory_cleanup_items_cleanup_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_cleanup_items
    ADD CONSTRAINT memory_cleanup_items_cleanup_task_id_fkey FOREIGN KEY (cleanup_task_id) REFERENCES public.memory_cleanup_tasks(id) ON DELETE CASCADE;


--

-- Name: memory_ingest_batches memory_ingest_batches_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_ingest_batches
    ADD CONSTRAINT memory_ingest_batches_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.agent_sessions(id) ON DELETE CASCADE;


--

-- Name: memory_ingest_cursors memory_ingest_cursors_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_ingest_cursors
    ADD CONSTRAINT memory_ingest_cursors_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.agent_sessions(id) ON DELETE CASCADE;


--

-- Name: memory_promotion_items memory_promotion_items_promotion_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_promotion_items
    ADD CONSTRAINT memory_promotion_items_promotion_task_id_fkey FOREIGN KEY (promotion_task_id) REFERENCES public.memory_promotion_tasks(id) ON DELETE CASCADE;


--

-- Name: memory_promotion_tasks memory_promotion_tasks_landing_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_promotion_tasks
    ADD CONSTRAINT memory_promotion_tasks_landing_request_id_fkey FOREIGN KEY (landing_request_id) REFERENCES public.landing_requests(id) ON DELETE CASCADE;


--

-- Name: memory_promotion_tasks memory_promotion_tasks_repository_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_promotion_tasks
    ADD CONSTRAINT memory_promotion_tasks_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;


--

-- Name: repo_gateways repo_gateways_landing_token_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_gateways
    ADD CONSTRAINT repo_gateways_landing_token_id_fkey FOREIGN KEY (landing_token_id) REFERENCES public.access_tokens(id) ON DELETE SET NULL;


--

-- Name: repo_gateways repo_gateways_repository_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_gateways
    ADD CONSTRAINT repo_gateways_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;


--

-- Name: repo_gateways repo_gateways_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_gateways
    ADD CONSTRAINT repo_gateways_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--

-- Name: repo_gateways repo_gateways_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_gateways
    ADD CONSTRAINT repo_gateways_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--

-- Name: repo_replicas repo_replicas_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_replicas
    ADD CONSTRAINT repo_replicas_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.repo_storage_nodes(id) ON DELETE CASCADE;


--

-- Name: repo_replicas repo_replicas_repository_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_replicas
    ADD CONSTRAINT repo_replicas_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;


--

-- Name: repo_replication_jobs repo_replication_jobs_repository_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_replication_jobs
    ADD CONSTRAINT repo_replication_jobs_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;


--

-- Name: repo_replication_jobs repo_replication_jobs_source_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_replication_jobs
    ADD CONSTRAINT repo_replication_jobs_source_node_id_fkey FOREIGN KEY (source_node_id) REFERENCES public.repo_storage_nodes(id) ON DELETE SET NULL;


--

-- Name: repo_replication_jobs repo_replication_jobs_target_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_replication_jobs
    ADD CONSTRAINT repo_replication_jobs_target_node_id_fkey FOREIGN KEY (target_node_id) REFERENCES public.repo_storage_nodes(id) ON DELETE CASCADE;


--

-- Name: repo_storage_nodes repo_storage_nodes_storage_set_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_storage_nodes
    ADD CONSTRAINT repo_storage_nodes_storage_set_id_fkey FOREIGN KEY (storage_set_id) REFERENCES public.repo_storage_sets(id) ON DELETE CASCADE;


--

-- Name: repo_write_locks repo_write_locks_repository_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_write_locks
    ADD CONSTRAINT repo_write_locks_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;


--

-- Name: repository_provisioning_operations repository_provisioning_operations_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_provisioning_operations
    ADD CONSTRAINT repository_provisioning_operations_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--

-- Name: repository_provisioning_operations repository_provisioning_operations_fork_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_provisioning_operations
    ADD CONSTRAINT repository_provisioning_operations_fork_id_fkey FOREIGN KEY (fork_id) REFERENCES public.repositories(id) ON DELETE RESTRICT;


--

-- Name: repository_provisioning_operations repository_provisioning_operations_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_provisioning_operations
    ADD CONSTRAINT repository_provisioning_operations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--

-- Name: repository_provisioning_operations repository_provisioning_operations_source_repository_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_provisioning_operations
    ADD CONSTRAINT repository_provisioning_operations_source_repository_id_fkey FOREIGN KEY (source_repository_id) REFERENCES public.repositories(id) ON DELETE RESTRICT;


--

-- Name: repository_provisioning_operations repository_provisioning_operations_source_storage_set_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_provisioning_operations
    ADD CONSTRAINT repository_provisioning_operations_source_storage_set_id_fkey FOREIGN KEY (source_storage_set_id) REFERENCES public.repo_storage_sets(id);


--

-- Name: repository_provisioning_operations repository_provisioning_operations_storage_set_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_provisioning_operations
    ADD CONSTRAINT repository_provisioning_operations_storage_set_id_fkey FOREIGN KEY (storage_set_id) REFERENCES public.repo_storage_sets(id);


--

-- Name: repository_provisioning_operations repository_provisioning_operations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_provisioning_operations
    ADD CONSTRAINT repository_provisioning_operations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--

-- Name: sandbox_access_grants sandbox_access_grants_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_access_grants
    ADD CONSTRAINT sandbox_access_grants_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES public.sandbox_access_identities(id) ON DELETE CASCADE;


--

-- Name: sandbox_access_permissions sandbox_access_permissions_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_access_permissions
    ADD CONSTRAINT sandbox_access_permissions_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES public.sandbox_access_identities(id) ON DELETE CASCADE;


--

-- Name: sandbox_access_permissions sandbox_access_permissions_sandbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_access_permissions
    ADD CONSTRAINT sandbox_access_permissions_sandbox_id_fkey FOREIGN KEY (sandbox_id) REFERENCES public.sandbox_instances(id) ON DELETE CASCADE;


--

-- Name: sandbox_access_tokens sandbox_access_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_access_tokens
    ADD CONSTRAINT sandbox_access_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--

-- Name: sandbox_access_tokens sandbox_access_tokens_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_access_tokens
    ADD CONSTRAINT sandbox_access_tokens_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--

-- Name: sandbox_domain_mappings sandbox_domain_mappings_sandbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_domain_mappings
    ADD CONSTRAINT sandbox_domain_mappings_sandbox_id_fkey FOREIGN KEY (sandbox_id) REFERENCES public.sandbox_instances(id) ON DELETE CASCADE;


--

-- Name: sandbox_egress_audit sandbox_egress_audit_repository_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_egress_audit
    ADD CONSTRAINT sandbox_egress_audit_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE SET NULL;


--

-- Name: sandbox_environment_images sandbox_environment_images_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_environment_images
    ADD CONSTRAINT sandbox_environment_images_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--

-- Name: sandbox_environment_images sandbox_environment_images_repository_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_environment_images
    ADD CONSTRAINT sandbox_environment_images_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;


--

-- Name: sandbox_instances sandbox_instances_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_instances
    ADD CONSTRAINT sandbox_instances_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.sandbox_hosts(id) ON DELETE SET NULL;


--

-- Name: sandbox_operations sandbox_operations_sandbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_operations
    ADD CONSTRAINT sandbox_operations_sandbox_id_fkey FOREIGN KEY (sandbox_id) REFERENCES public.sandbox_instances(id) ON DELETE CASCADE;


--

-- Name: sandbox_orphans sandbox_orphans_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_orphans
    ADD CONSTRAINT sandbox_orphans_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.sandbox_hosts(id) ON DELETE CASCADE;


--

-- Name: sandbox_snapshots sandbox_snapshots_source_sandbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_snapshots
    ADD CONSTRAINT sandbox_snapshots_source_sandbox_id_fkey FOREIGN KEY (source_sandbox_id) REFERENCES public.sandbox_instances(id) ON DELETE SET NULL;


--

-- Name: sandbox_snapshots sandbox_snapshots_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_snapshots
    ADD CONSTRAINT sandbox_snapshots_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.sandbox_hosts(id) ON DELETE SET NULL;


--

-- Name: sandbox_volumes sandbox_volumes_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_volumes
    ADD CONSTRAINT sandbox_volumes_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.sandbox_hosts(id) ON DELETE SET NULL;


--

-- Name: workflow_run_coding_hosts workflow_run_coding_hosts_workflow_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_run_coding_hosts
    ADD CONSTRAINT workflow_run_coding_hosts_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES public.workflow_runs(id) ON DELETE CASCADE;


--

-- Name: workflow_run_coding_hosts workflow_run_coding_hosts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_run_coding_hosts
    ADD CONSTRAINT workflow_run_coding_hosts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--

-- Name: workflow_sandbox_claims workflow_sandbox_claims_workflow_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_sandbox_claims
    ADD CONSTRAINT workflow_sandbox_claims_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES public.workflow_runs(id) ON DELETE CASCADE;


--

-- Name: workflow_tasks workflow_tasks_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_tasks
    ADD CONSTRAINT workflow_tasks_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runner_pool(id) ON DELETE SET NULL;


--

-- The old hosted storage-deletion gate starts fail-closed until an operator
-- attests that all legacy final-key uploaders have drained.
INSERT INTO public.storage_legacy_capability_horizons (capability_kind, valid_until)
VALUES ('legacy-final-key-upload', 'infinity'::timestamptz)
ON CONFLICT (capability_kind) DO NOTHING;
